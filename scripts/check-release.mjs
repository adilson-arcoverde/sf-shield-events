// Refuses to publish anything but the tagged release commit with a clean tree.
//
// npm packs whatever is on disk, and a working tree that is one edit past the release commit
// publishes that edit under the release's number, where nothing in git says so. The check is
// two questions: is the tree clean, and does the version in package.json have its tag on HEAD.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const git = (command) => execSync(`git ${command}`, { encoding: 'utf8' }).trim();

const dirty = git('status --porcelain');

if (dirty) {
  console.error(`Not publishing: the working tree has changes that are not committed.\n${dirty}`);
  process.exit(1);
}

const tags = git('tag --points-at HEAD').split('\n');

if (!tags.includes(`v${version}`)) {
  console.error(`Not publishing: HEAD is not tagged v${version}. Tag the release commit first, then publish from it.`);
  process.exit(1);
}
