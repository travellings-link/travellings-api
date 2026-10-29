const COUNTERS = {
    random_requests_total: 'Random GET requests, including unsuccessful requests.',
    random_bloom_hits_total: 'Actually inspected candidates whose Bloom check returned true.',
    random_fallback_total: 'Requests using same-batch fallback.',
    random_errors_total: 'Unexpected failures while processing random requests.',
    random_cache_hits_total: 'Requests whose initial candidate-cache read found a batch.',
    random_cache_misses_total: 'Requests whose initial candidate-cache read found no batch.',
    random_cache_refills_total: 'Candidate-pool refills with a successful publish acknowledgement.',
};
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

class RandomMetrics {
    constructor() {
        this.counters = Object.fromEntries(Object.keys(COUNTERS).map(name => [name, 0]));
        this.duration = { count: 0, sum: 0, buckets: DURATION_BUCKETS.map(le => ({ le, count: 0 })) };
    }

    increment(name, amount = 1) {
        if (!Object.hasOwn(this.counters, name)) throw new TypeError('Unknown random metric');
        this.counters[name] += amount;
    }

    observeQuery(seconds) {
        this.duration.count++;
        this.duration.sum += seconds;
        for (const bucket of this.duration.buckets) {
            if (seconds <= bucket.le) bucket.count++;
        }
    }

    snapshot() {
        return {
            ...this.counters,
            random_query_duration_seconds: {
                count: this.duration.count,
                sum: this.duration.sum,
                buckets: [...this.duration.buckets.map(bucket => ({ ...bucket })), { le: '+Inf', count: this.duration.count }],
            },
        };
    }

    toPrometheus() {
        const lines = [];
        for (const [name, help] of Object.entries(COUNTERS)) {
            lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`, `${name} ${this.counters[name]}`);
        }
        const name = 'random_query_duration_seconds';
        lines.push(`# HELP ${name} Actual SQL candidate-query latency in seconds, including pool wait and failed queries.`, `# TYPE ${name} histogram`);
        for (const { le, count } of this.snapshot()[name].buckets) {
            lines.push(`${name}_bucket{le="${le}"} ${count}`);
        }
        lines.push(`${name}_sum ${this.duration.sum}`, `${name}_count ${this.duration.count}`);
        return `${lines.join('\n')}\n`;
    }
}

module.exports = { RandomMetrics };
