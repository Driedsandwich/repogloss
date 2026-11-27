// 提出候補は、GitHub の CI の実行の記録と成果物で確かめる。
// 聞き先は固定し、身元の記録に書かれた repository を聞き先には使わない。
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const REPOSITORY = 'Driedsandwich/repogloss';
const WORKFLOW_PATH = '.github/workflows/ci.yml';
const ARTIFACT_NAME = 'repogloss-store-zip';
const DIGITS = /^\d+$/;
const execFileAsync = promisify(execFile);

async function gh(args) {
  const { stdout } = await execFileAsync('gh', args, { encoding: 'utf8', shell: false });
  return stdout;
}

const defaultDeps = {
  async getRun(runId) {
    const out = await gh(['api', `repos/${REPOSITORY}/actions/runs/${runId}`]);
    return JSON.parse(out);
  },

  async getArtifactZip(runId, artifactName, zipName) {
    const dir = mkdtempSync(join(tmpdir(), 'repogloss-release-'));
    try {
      await gh(['run', 'download', runId, '-R', REPOSITORY, '-n', artifactName, '-D', dir]);
      try {
        return readFileSync(join(dir, zipName));
      } catch (e) {
        if (e.code === 'ENOENT') return null;   // 成果物が無い・期限切れ
        throw e;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
};

const errorText = e => e instanceof Error ? e.message : String(e);

/**
 * @returns 問題の文の配列。空なら合格。確かめられないことも合格にはしない。
 */
export async function verifyReleaseOrigin(rec, zipBytes, deps = defaultDeps) {
  const problems = [];
  try {
    const source = rec && typeof rec === 'object' ? rec.source : null;
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      return ['身元の記録に source が無い'];
    }
    if (source.builtInCI !== true) problems.push('CI で作った記録になっていない');
    if (source.repository !== REPOSITORY) problems.push(`記録の repository が ${REPOSITORY} でない`);
    const runId = source.workflowRunId;
    if (typeof runId !== 'string' || !DIGITS.test(runId)) {
      problems.push('記録の workflowRunId が数字の文字列でない');
    }
    if (problems.length) return problems;

    let run;
    try {
      run = await deps.getRun(runId);
    } catch (e) {
      return [`GitHub の実行の記録を確かめられない: ${errorText(e)}`];
    }
    if (!run || typeof run !== 'object' || Array.isArray(run)) {
      return ['GitHub の実行の記録が object でない'];
    }

    if (String(run.id) !== runId) problems.push(`聞いた実行と id が違う: ${run.id}`);
    if (run.repository?.full_name !== REPOSITORY) problems.push('実行の repository が違う');
    if (run.path !== WORKFLOW_PATH) problems.push('実行のワークフローが違う');
    if (run.event !== 'push') problems.push('push の実行でない');
    if (run.head_branch !== 'main') problems.push('main の実行でない');
    if (run.status !== 'completed') problems.push('実行が完了していない');
    if (run.conclusion !== 'success') problems.push('実行が成功していない');
    if (run.head_sha !== source.commit) problems.push('実行の commit が身元の記録と違う');
    if (problems.length) return problems;

    let artifact;
    try {
      artifact = await deps.getArtifactZip(runId, ARTIFACT_NAME, rec.name);
    } catch (e) {
      return [`GitHub の成果物を確かめられない: ${errorText(e)}`];
    }
    if (artifact === null || artifact === undefined) {
      problems.push('GitHub の成果物が無い・期限切れ');
    } else if (!Buffer.isBuffer(artifact) || !Buffer.isBuffer(zipBytes)) {
      problems.push('ZIP のバイト列を比較できない');
    } else if (!artifact.equals(zipBytes)) {
      problems.push('GitHub の成果物の ZIP と手元の ZIP がバイトで違う');
    }
  } catch (e) {
    problems.push(`出どころを確かめられない: ${errorText(e)}`);
  }
  return problems;
}
