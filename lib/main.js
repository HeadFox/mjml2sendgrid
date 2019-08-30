const github = require("@actions/github");
const core = require("@actions/core");
const client = require("@sendgrid/client");
const mjml2html = require("mjml");

/**
 *
 *
 * @param {*} templateId
 * @returns
 */
const getActiveVersion = templateId => {
  const request = {
    method: "GET",
    url: `/v3/templates/${templateId}`
  };
  return client
    .request(request)
    .then(([response, body]) => {
      const activeVersion = body.versions.find(version => {
        return version.active;
      });
      return activeVersion;
    })
    .catch(err => err);
};

/**
 *
 *
 * @param {*} templateId
 * @param {*} activeVersion
 * @param {*} htmlContent
 */

const patchNewContent = (templateId, activeVersion, htmlContent) => {
  const requestVersion = {
    method: "PATCH",
    url: `/v3/templates/${templateId}/versions/${activeVersion.id}`,
    body: {
      name: activeVersion.name,
      subject: activeVersion.subject,
      html_content: htmlContent.html
    }
  };
  return client
    .request(requestVersion)
    .then(data => data)
    .catch(err => err);
};
async function run() {
  try {
    const githubToken = process.env.GITHUB_TOKEN;
    const sendGridApiKey = process.env.SENDGRID_API_KEY;
    if (!sendGridApiKey || sendGridApiKey == "") {
      throw new Error(
        "'sendgrid-api-key' input missing, please include it in your workflow settings 'with' section as 'sendgrid-api-key: ${{ secrets.sendgrid_api_key }}'"
      );
    }
    if (!githubToken || githubToken == "") {
      throw new Error(
        "'github-token' input missing, please include it in your workflow settings 'with' section as 'github-token: ${{ secrets.github_token }}'"
      );
    }

    client.setApiKey(sendGridApiKey);
    const octokit = new github.GitHub(githubToken);
    const owner =
      process.env.GITHUB_OWNER || github.context.payload.repository.owner.login;
    const repo =
      process.env.GITHUB_REPO || github.context.payload.repository.name;
    const pull_number = process.env.GITHUB_PR || github.context.payload.number;
    const { data } = await octokit.pulls.listFiles({
      owner,
      repo,
      pull_number
    });

    const PR = await octokit.pulls.get({
      owner,
      repo,
      pull_number
    });
    const getAliasFile = async path => {
      const aliasBlob = await octokit.repos.getContents({
        owner,
        repo,
        path,
        ref: PR.data.head.ref
      });
      const aliasContent = Buffer.from(
        aliasBlob.data.content,
        "base64"
      ).toString("utf8");
      return aliasContent;
    };

    const configBlob = await octokit.repos.getContents({
      owner,
      repo,
      path: "mjmj2sendgrid.json",
      ref: PR.data.head.ref
    });
    const configContent = Buffer.from(
      configBlob.data.content,
      "base64"
    ).toString("utf8");
    const config = JSON.parse(configContent);

    const filterFiles = data.filter(
      file => file.filename.indexOf(".mjml") !== -1
    );
    const filesContent = await Promise.all(
      filterFiles.map(file =>
        octokit.git.getBlob({
          repo,
          owner,
          file_sha: file.sha
        })
      )
    );

    if (!filesContent.length) {
      core.warning("No mjml file found");
      return;
    }

    filesContent.map(async file => {
      const regex = /\[id](.*?)\[\/id]/;
      const regex2 = /<mj-include\s+(?:[^>]*?\s+)?.*absolute-path="(.*?)".*\/>/g;

      let mjmlContent = Buffer.from(file.data.content, "base64").toString(
        "utf8"
      );
      const matchRegex = mjmlContent.match(regex);
      const matchRegex2 = [...mjmlContent.matchAll(regex2)];
      const includeFiles = {};
      const readyContent = matchRegex2.map(async item => {
        if (!includeFiles[item[1]]) {
          const aliasFile = await getAliasFile(item[1]);
          includeFiles[item[1]] = {
            file: aliasFile,
            codeLine: item[0]
          };
        }
      });
      await Promise.all(readyContent);
      if (matchRegex) {
        const templateId = matchRegex[1];
        mjmlContent = mjmlContent.replace(
          `<mj-raw>${matchRegex[0]}</mj-raw>`,
          ""
        );
        Object.keys(includeFiles).forEach(key => {
          mjmlContent = mjmlContent.replace(
            includeFiles[key].codeLine,
            includeFiles[key].file
          );
        });
        const htmlContent = mjml2html(mjmlContent);

        const activeVersion = await getActiveVersion(templateId);
        await patchNewContent(templateId, activeVersion, htmlContent);
      }
    });
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
