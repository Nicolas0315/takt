import { describe, expect, it, vi } from 'vitest';

const { lstatSyncMock } = vi.hoisted(() => ({
  lstatSyncMock: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  lstatSync: lstatSyncMock,
}));

import { collectCopyTargets } from '../../features/repertoire/file-filter.js';

describe('repertoire copy target collection errors', () => {
  it('should reject a discovered package directory inspection failure instead of copying a partial package', () => {
    const directory = '/package/facets';
    const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    lstatSyncMock.mockImplementationOnce(() => {
      throw error;
    });

    expect(() => collectCopyTargets('/package')).toThrow(`Failed to inspect package directory: ${directory}`);
  });
});
