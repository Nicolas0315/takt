import { existsSync, lstatSync, realpathSync, type Stats } from 'node:fs';
import * as path from 'node:path';

function isNormalizedPathInside(basePath: string, candidatePath: string): boolean {
  if (basePath === candidatePath) {
    return true;
  }

  return candidatePath.startsWith(basePath + path.sep);
}

export function isPathInside(basePath: string, candidatePath: string): boolean {
  const resolvedBase = path.resolve(basePath);
  const resolvedCandidate = path.resolve(candidatePath);

  return isNormalizedPathInside(resolvedBase, resolvedCandidate);
}

// Lexical check only: the referenced file may not exist yet when the value is
// validated, so symlinks are out of scope here (isRealPathInside covers reads).
// win32 rules are a superset of posix here (both separators, drive prefixes),
// and they apply regardless of the host: a meta file written on one platform
// must not smuggle an absolute or escaping path onto the other. Everything is
// checked against one normalized form so no rule sees a different spelling.
export function isProjectRelativePath(candidatePath: string): boolean {
  const normalized = path.win32.normalize(candidatePath);
  if (path.win32.isAbsolute(normalized)) {
    return false;
  }
  return !normalized
    .split('\\')
    .some((segment) => segment === '..' || /^[A-Za-z]:/.test(segment));
}

export function lstatIfExists(targetPath: string): Stats | null {
  try {
    return lstatSync(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export function isRealPathInside(basePath: string, candidatePath: string): boolean {
  const resolvedBase = path.resolve(basePath);
  const resolvedCandidate = path.resolve(candidatePath);
  const normalizedBase = existsSync(resolvedBase) ? realpathSync(resolvedBase) : resolvedBase;
  const normalizedCandidate = existsSync(resolvedCandidate) ? realpathSync(resolvedCandidate) : resolvedCandidate;

  return isNormalizedPathInside(normalizedBase, normalizedCandidate);
}

export type BoundaryViolation = 'outside' | 'symlink' | 'not_directory';

export interface SafePathSegmentInspection {
  readonly resolvedRoot: string;
  readonly resolvedTarget: string;
  readonly segments: readonly {
    readonly path: string;
    readonly stats: Stats | null;
  }[];
}

export function inspectSafePathSegments(
  rootDir: string,
  targetPath: string,
  buildError: (violation: BoundaryViolation, segmentPath: string) => Error,
  options?: { readonly rejectSamePath?: boolean },
): SafePathSegmentInspection {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(targetPath);
  if (!isPathInside(resolvedRoot, resolvedTarget) || (options?.rejectSamePath && resolvedRoot === resolvedTarget)) {
    throw buildError('outside', targetPath);
  }

  const segments = path.relative(resolvedRoot, resolvedTarget)
    .split(path.sep)
    .filter((segment) => segment.length > 0);

  let current = resolvedRoot;
  const inspectedSegments: Array<{ path: string; stats: Stats | null }> = [];
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stats = lstatIfExists(current);
    inspectedSegments.push({ path: current, stats });
    if (stats === null) {
      break;
    }
    if (stats.isSymbolicLink()) {
      throw buildError('symlink', current);
    }
    if (index < segments.length - 1 && !stats.isDirectory()) {
      throw buildError('not_directory', current);
    }
  }
  return {
    resolvedRoot,
    resolvedTarget,
    segments: inspectedSegments,
  };
}

export function assertPathSegmentsAreSafe(
  rootDir: string,
  targetPath: string,
  buildError: (violation: BoundaryViolation, segmentPath: string) => Error,
  options?: { readonly rejectSamePath?: boolean },
): Stats | null {
  const inspection = inspectSafePathSegments(rootDir, targetPath, buildError, options);
  return inspection.segments.at(-1)?.stats ?? null;
}
