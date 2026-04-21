import { existsSync, readFileSync, promises as fs } from "fs"
import * as core from "@actions/core"
import { getOctokit, context } from "@actions/github"
import axios from "axios"
import path from "path"

import { parse } from "./lcov"
import { diff } from "./comment"
import { getChangedFiles } from "./get_changes"
import { deleteOldComments } from "./delete_old_comments"
import { normalisePath } from "./util"

const MAX_COMMENT_CHARS = 65536

async function validateSubscription() {
	const eventPath = process.env.GITHUB_EVENT_PATH
	let repoPrivate

	if (eventPath && existsSync(eventPath)) {
		const eventData = JSON.parse(readFileSync(eventPath, "utf8"))
		repoPrivate = eventData?.repository?.private
	}

	const upstream = "romeovs/lcov-reporter-action"
	const action = process.env.GITHUB_ACTION_REPOSITORY
	const docsUrl =
		"https://docs.stepsecurity.io/actions/stepsecurity-maintained-actions"

	core.info("")
	core.info("\u001b[1;36mStepSecurity Maintained Action\u001b[0m")
	core.info(`Secure drop-in replacement for ${upstream}`)
	if (repoPrivate === false)
		core.info("\u001b[32m\u2713 Free for public repositories\u001b[0m")
	core.info(`\u001b[36mLearn more:\u001b[0m ${docsUrl}`)
	core.info("")

	if (repoPrivate === false) return

	const serverUrl = process.env.GITHUB_SERVER_URL || "https://github.com"
	const body = { action: action || "" }
	if (serverUrl !== "https://github.com") body.ghes_server = serverUrl
	try {
		await axios.post(
			`https://agent.api.stepsecurity.io/v1/github/${process.env.GITHUB_REPOSITORY}/actions/maintained-actions-subscription`,
			body,
			{ timeout: 3000 },
		)
	} catch (error) {
		if (axios.isAxiosError(error) && error.response?.status === 403) {
			core.error(
				"\u001b[1;31mThis action requires a StepSecurity subscription for private repositories.\u001b[0m",
			)
			core.error(
				`\u001b[31mLearn how to enable a subscription: ${docsUrl}\u001b[0m`,
			)
			process.exit(1)
		}
		core.info("Timeout or API not reachable. Continuing to next step.")
	}
}

async function main() {
	await validateSubscription()
	const token = core.getInput("github-token")
	const githubClient = getOctokit(token)
	const workingDir = core.getInput("working-directory") || "./"
	const lcovFile = path.join(
		workingDir,
		core.getInput("lcov-file") || "./coverage/lcov.info",
	)
	const baseFile = core.getInput("lcov-base")
	const shouldFilterChangedFiles =
		core.getInput("filter-changed-files").toLowerCase() === "true"
	const shouldDeleteOldComments =
		core.getInput("delete-old-comments").toLowerCase() === "true"
	const title = core.getInput("title")

	const raw = await fs.readFile(lcovFile, "utf-8").catch(err => null)
	if (!raw) {
		console.log(`No coverage report found at '${lcovFile}', exiting...`)
		return
	}

	const baseRaw =
		baseFile && (await fs.readFile(baseFile, "utf-8").catch(err => null))
	if (baseFile && !baseRaw) {
		console.log(`No coverage report found at '${baseFile}', ignoring...`)
	}

	const options = {
		repository: context.payload.repository.full_name,
		prefix: normalisePath(`${process.env.GITHUB_WORKSPACE}/`),
		workingDir,
	}

	if (
		context.eventName === "pull_request" ||
		context.eventName === "pull_request_target"
	) {
		options.commit = context.payload.pull_request.head.sha
		options.baseCommit = context.payload.pull_request.base.sha
		options.head = context.payload.pull_request.head.ref
		options.base = context.payload.pull_request.base.ref
	} else if (context.eventName === "push") {
		options.commit = context.payload.after
		options.baseCommit = context.payload.before
		options.head = context.ref
	}

	options.shouldFilterChangedFiles = shouldFilterChangedFiles
	options.title = title

	if (shouldFilterChangedFiles) {
		options.changedFiles = await getChangedFiles(githubClient, options, context)
	}

	const lcov = await parse(raw)
	const baselcov = baseRaw && (await parse(baseRaw))
	const body = diff(lcov, baselcov, options).substring(0, MAX_COMMENT_CHARS)

	if (shouldDeleteOldComments) {
		await deleteOldComments(githubClient, options, context)
	}

	if (
		context.eventName === "pull_request" ||
		context.eventName === "pull_request_target"
	) {
		await githubClient.rest.issues.createComment({
			repo: context.repo.repo,
			owner: context.repo.owner,
			issue_number: context.payload.pull_request.number,
			body: body,
		})
	} else if (context.eventName === "push") {
		await githubClient.rest.repos.createCommitComment({
			repo: context.repo.repo,
			owner: context.repo.owner,
			commit_sha: options.commit,
			body: body,
		})
	}
}

main().catch(function(err) {
	console.log(err)
	core.setFailed(err.message)
})
