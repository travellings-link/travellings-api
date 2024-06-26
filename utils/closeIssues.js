/* Copyright © 2024 Travellings Project
  Close Github Issues By IssuesID Util
  By BLxcwg666 <huixcwg@gmail.com>
  Suggestion By @xuanzhi33
*/

// const log = require('../modules/logger');
const fs = require('fs');
const { App } = require('octokit');

const app = new App({
    appId: 849785,
    privateKey: fs.readFileSync(process.env.GH_PRIVATE_KEY),
    baseUrl: 'https://ghapi.xcnya.cn'
});

async function closeIssues (id) {
    const octokit = await app.getInstallationOctokit(48087189);
    await octokit.request(`PATCH /repos/travellings-link/travellings/issues/${id}`, {
        state: 'closed',
        headers: {
            'X-GitHub-Api-Version': '2022-11-28'
        }
    })
}

module.exports = closeIssues;