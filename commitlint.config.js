export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Chinese subjects are fine; keep the header readable in `git log --oneline`
    'header-max-length': [2, 'always', 100],
    'subject-case': [0],
  },
}
