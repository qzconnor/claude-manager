// semantic-release (`.github/workflows/release.yml`): the version from the Conventional Commits on
// master, the release notes with one line per change, the installers as assets of the GitHub release.
// JavaScript instead of `.releaserc.json` for `finalizeContext`; Node runs the TypeScript it imports.
import { splitReleaseNotes } from './src/shared/release-notes.ts'

/** The sections of the release notes; the other types bring no release and stay out of them. */
const types = [
  { type: 'feat', section: 'Neue Funktionen' },
  { type: 'fix', section: 'Fehlerbehebungen' },
  { type: 'perf', section: 'Schneller' },
  { type: 'revert', section: 'Zurückgenommen' },
  { type: 'refactor', hidden: true },
  { type: 'docs', hidden: true },
  { type: 'style', hidden: true },
  { type: 'test', hidden: true },
  { type: 'build', hidden: true },
  { type: 'ci', hidden: true },
  { type: 'chore', hidden: true },
]

export default {
  branches: ['master'],
  tagFormat: 'v${version}',
  plugins: [
    ['@semantic-release/commit-analyzer', { preset: 'conventionalcommits' }],
    [
      '@semantic-release/release-notes-generator',
      {
        preset: 'conventionalcommits',
        presetConfig: { types },
        // Each change a pull request lists under `## Versionshinweise` (or its title, separated by `; `) is a line of its own.
        writerOpts: { finalizeContext: (context) => splitReleaseNotes(context, types) },
      },
    ],
    ['@semantic-release/exec', { verifyReleaseCmd: 'echo ${nextRelease.version} > .release-version' }],
    [
      '@semantic-release/github',
      {
        assets: [
          { path: 'release/*/Claude-Manager-*-Setup.exe', label: 'Windows-Installer' },
          { path: 'release/*/Claude-Manager-*-Setup.exe.blockmap' },
          { path: 'release/*/latest.yml' },
          { path: 'release/*/Claude-Manager-*.AppImage', label: 'Linux (AppImage, alle Distributionen)' },
          { path: 'release/*/Claude-Manager-*.deb', label: 'Linux (deb, Debian/Ubuntu)' },
          { path: 'release/*/Claude-Manager-*.rpm', label: 'Linux (rpm, Fedora/openSUSE)' },
          { path: 'release/*/latest-linux.yml' },
        ],
        successComment: false,
        failComment: false,
        releasedLabels: false,
      },
    ],
  ],
}
