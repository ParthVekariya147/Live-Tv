import React from 'react';
import { BUILD_INFO } from '../utils/buildInfo';

export default function BuildFooter() {
  const { name, version, builtAt, commit, mode } = BUILD_INFO;
  const isProduction = mode === 'Production';
  const commitText = commit && commit !== 'unknown' ? ` | Commit: ${commit}` : '';

  return (
    <div className="build-footer">
      <span className="build-footer-name">{name} v{version}</span>
      <span className="build-footer-sep"> | </span>
      <span>Built: {builtAt}</span>
      {commitText && <span>{commitText}</span>}
      <span className="build-footer-sep"> | </span>
      <span className={isProduction ? 'build-footer-prod' : 'build-footer-dev'}>
        {mode} Build
      </span>
    </div>
  );
}
