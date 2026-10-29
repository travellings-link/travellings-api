const COUNTERS = {
    random_requests_total: 'Random GET requests, including unsuccessful requests.',
    random_bloom_hits_total: 'Actually inspected candidates whose check matched either rolling Bloom generation.',
    random_fallback_total: 'Requests selecting from their original batch after relaxing rolling Bloom history.',
    random_history_relaxations_total: 'Fallback selections that discarded the previous generation or reset both generations.',
    random_history_resets_total: 'Fallback selections that reset both Bloom generations and the generation counter.',
    random_errors_total: 'Unexpected failures while processing random requests.',
    random_cache_hits_total: 'Requests whose initial candidate-cache read found a batch.',
    random_cache_misses_total: 'Requests whose initial candidate-cache read found no batch.',
    random_cache_refills_total: 'Candidate-pool refills with a successful publish acknowledgement.',
    random_resample_attempts_total: 'Requests requiring supplemental random sampling after their initial batch was filtered.',
    random_resample_queries_total: 'Supplemental random queries admitted by the concurrency and rate budget.',
    random_resample_rejected_total: 'Supplemental random-query attempts rejected by the concurrency or rate budget.',
    random_resample_errors_total: 'Admitted supplemental queries or result validations that failed.',
    random_resample_unresolved_total: 'Successful supplemental samples with no candidate passing the rolling Bloom checks.',
};
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const HISTOGRAMS = {
    random_query_duration_seconds: 'Actual SQL candidate-query latency in seconds, including pool wait and failed queries.',
    random_prefetch_query_duration_seconds: 'SQL sampling-query latency in seconds, including pool wait and failed queries.',
    random_resample_query_duration_seconds: 'Supplemental random-query latency in seconds, including pool wait and failed queries.',
    random_request_duration_seconds: 'Application random GET processing latency in seconds, including unsuccessful requests.',
};

function histogram() {
    return { count: 0, sum: 0, buckets: DURATION_BUCKETS.map(le => ({ le, count: 0 })) };
}

function observe(histogram, seconds) {
    histogram.count++;
    histogram.sum += seconds;
    for (const bucket of histogram.buckets) {
        if (seconds <= bucket.le) bucket.count++;
    }
}

function snapshotHistogram(histogram) {
    return {
        count: histogram.count,
        sum: histogram.sum,
        buckets: [...histogram.buckets.map(bucket => ({ ...bucket })), { le: '+Inf', count: histogram.count }],
    };
}

class RandomMetrics {
    constructor() {
        this.counters = Object.fromEntries(Object.keys(COUNTERS).map(name => [name, 0]));
        this.histograms = Object.fromEntries(Object.keys(HISTOGRAMS).map(name => [name, histogram()]));
    }

    increment(name, amount = 1) {
        if (!Object.hasOwn(this.counters, name)) throw new TypeError('Unknown random metric');
        this.counters[name] += amount;
    }

    observeQuery(seconds, source = 'prefetch') {
        if (!['prefetch', 'resample'].includes(source)) throw new TypeError('Unknown random query source');
        observe(this.histograms.random_query_duration_seconds, seconds);
        observe(this.histograms[`random_${source}_query_duration_seconds`], seconds);
    }

    observeRequest(seconds) {
        observe(this.histograms.random_request_duration_seconds, seconds);
    }

    snapshot() {
        return {
            ...this.counters,
            ...Object.fromEntries(Object.entries(this.histograms).map(([name, histogram]) => [name, snapshotHistogram(histogram)])),
        };
    }

    toPrometheus() {
        const lines = [];
        for (const [name, help] of Object.entries(COUNTERS)) {
            lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`, `${name} ${this.counters[name]}`);
        }
        for (const [name, help] of Object.entries(HISTOGRAMS)) {
            const histogram = this.histograms[name];
            lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} histogram`);
            for (const { le, count } of snapshotHistogram(histogram).buckets) {
                lines.push(`${name}_bucket{le="${le}"} ${count}`);
            }
            lines.push(`${name}_sum ${histogram.sum}`, `${name}_count ${histogram.count}`);
        }
        return `${lines.join('\n')}\n`;
    }
}

module.exports = { RandomMetrics };
