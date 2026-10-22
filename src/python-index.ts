// `mode: python-index`: verify that every distribution named in a
// requirements.txt-like file, at a version the file allows, exists on the
// configured Python package index. Fails the step (and therefore the CI job)
// when a library or version is missing.

import * as core from '@actions/core'
import { resolve } from 'node:path'
import { checkRequirements, displayIndexUrl, parseRequirementsFile } from './requirements.js'
import type { RequirementResult } from './requirements.js'
import { buildMarkerEnvironment, describeMarkerEnvironment } from './markers.js'

function html(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function statusLabel(result: RequirementResult): string {
  if (result.status === 'ok') return '✅ ok'
  if (result.status === 'skipped') return '⏭️ skipped'
  if (result.status === 'missing') return '❌ missing'
  return '💥 error'
}

export async function runPythonIndexCheck(): Promise<void> {
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd()
  const requirementsInput = core.getInput('requirements-file').trim() || 'requirements.txt'
  const requirementsFile = resolve(workspace, requirementsInput)
  const indexUrl = core.getInput('index-url').trim() || 'https://pypi.org/simple'
  const extraIndexUrls = core
    .getInput('extra-index-urls')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
  const allowPrerelease = core.getBooleanInput('allow-prerelease')
  const timeoutSeconds = Number(core.getInput('timeout-seconds').trim() || '30')
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error("The 'timeout-seconds' input must be a positive number.")
  }
  const pythonVersion = core.getInput('python-version').trim()
  const markerEnvironment = pythonVersion
    ? buildMarkerEnvironment({
        pythonVersion,
        platform: core.getInput('platform').trim() || 'linux',
        machine: core.getInput('platform-machine').trim(),
      })
    : undefined

  const indexUrls = [...new Set([indexUrl, ...extraIndexUrls])]

  const parsed = await parseRequirementsFile(requirementsFile, { workspace })
  for (const warning of parsed.warnings) core.warning(warning)
  core.info(`Checking ${requirementsFile} against ${indexUrls.map(displayIndexUrl).join(', ')} …`)
  if (markerEnvironment) {
    core.info(`Evaluating environment markers for ${describeMarkerEnvironment(markerEnvironment)}.`)
  } else if (parsed.requirements.some(requirement => requirement.marker !== undefined)) {
    core.warning(
      'Environment markers are not evaluated because the python-version input is empty; ' +
        'marker-gated requirements are checked unconditionally.'
    )
  }
  if (parsed.allowPrerelease && !allowPrerelease) {
    core.info('The requirements file requests pre-releases (--pre).')
  }

  if (parsed.requirements.length === 0) {
    core.warning(`${requirementsFile} contains no requirements to check.`)
    core.setOutput('checked-count', '0')
    core.setOutput('failed-count', '0')
    core.setOutput('skipped-count', '0')
    return
  }

  const results = await checkRequirements(parsed.requirements, {
    indexUrls,
    markerEnvironment,
    allowPrerelease: allowPrerelease || parsed.allowPrerelease,
    timeoutMs: Math.round(timeoutSeconds * 1000),
  })

  for (const result of results) {
    const message = `${result.requirement.raw} (${result.requirement.source}): ${result.detail}`
    if (result.status === 'ok') core.info(`✅ ${message}`)
    else if (result.status === 'skipped') core.warning(`⏭️ ${message}`)
    else if (result.status === 'missing') core.error(`❌ ${message}`)
    else core.error(`💥 ${message}`)
  }

  const failed = results.filter(result => result.status === 'missing' || result.status === 'error')
  const skipped = results.filter(result => result.status === 'skipped')
  core.setOutput('checked-count', String(results.length))
  core.setOutput('failed-count', String(failed.length))
  core.setOutput('skipped-count', String(skipped.length))

  const rows: { data: string; header?: boolean }[][] = [
    ['Requirement', 'Source', 'Result', 'Detail'].map(data => ({ data: html(data), header: true })),
    ...results.map(result => [
      { data: html(result.requirement.raw) },
      { data: html(result.requirement.source) },
      { data: statusLabel(result) },
      { data: html(result.detail) },
    ]),
  ]
  await core.summary
    .addHeading('Python index check', 2)
    .addRaw(
      `<p>Checked <strong>${results.length}</strong> requirement(s) against ` +
        `${indexUrls.map(url => `<code>${html(displayIndexUrl(url))}</code>`).join(', ')}: ` +
        `${failed.length} missing/error, ${skipped.length} skipped` +
        `${markerEnvironment ? `; markers evaluated for ${html(describeMarkerEnvironment(markerEnvironment))}` : ''}.</p>`
    )
    .addTable(rows)
    .write()

  if (failed.length > 0) {
    const names = failed
      .slice(0, 10)
      .map(result => `${result.requirement.raw} (${result.detail})`)
      .join('; ')
    const overflow = failed.length > 10 ? `; and ${failed.length - 10} more` : ''
    core.setFailed(
      `${failed.length} of ${results.length} requirement(s) are not available on the configured index: ` +
        `${names}${overflow}`
    )
    return
  }

  core.info(`All ${results.length - skipped.length} verifiable requirement(s) exist on the index.`)
}
