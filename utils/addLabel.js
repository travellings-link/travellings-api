/* Copyright © 2024 Travellings Project
  Github add Label By IssuesID Util
  By BLxcwg666 <huixcwg@gmail.com>
  Suggestion By @xuanzhi33
*/

// const log = require('../modules/logger');
const fs = require('fs');
const { App } = require('octokit');

const app = new App({
    appId: 849785,
    privateKey: fs.readFileSync(process.env.GH_PRIVATE_KEY),
    baseUrl: 'https://gh-api.nyakori.tech'
});

async function closeIssues (id) {
    const octokit = await app.getInstallationOctokit(48087189);
    await octokit.request(`PUT /repos/travellings-link/travellings/issues/${id}/labels`, {
        labels: [
            '信息更改完成',
        ],
        headers: {
            'X-GitHub-Api-Version': '2022-11-28'
        }
    })
}

module.exports = closeIssues;