export const BUILD_INFO = {
  name: __APP_NAME__,
  version: __APP_VERSION__,
  builtAt: __BUILD_TIME__,
  commit: __GIT_COMMIT__,
  mode: import.meta.env.MODE === 'production' ? 'Production' : 'Development',
};

export function getBuildLabel() {
  const { name, version, builtAt, commit, mode } = BUILD_INFO;
  const commitPart = commit && commit !== 'unknown' ? ` | Commit: ${commit}` : '';
  return `${name} v${version} | Built: ${builtAt}${commitPart} | ${mode}`;
}

export function getExeLabel() {
  const { name, version, builtAt } = BUILD_INFO;
  const datePart = builtAt.replace(/[-: ]/g, '').slice(0, 12);
  return `${name}-v${version}-Build-${datePart}`;
}
