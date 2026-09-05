import { describe, expect, it } from 'vitest';
import { DEFAULT_HTTP_HOST, DEFAULT_HTTP_PORT, DEV_ADMIN_TOKEN, ServerConfigurationError, resolveServerConfiguration } from '../src/config.ts';

function kindOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof ServerConfigurationError ? error.kind : `unexpected: ${String(error)}`;
  }
}

describe('resolveServerConfiguration', () => {
  it('a full environment resolves every field without dev defaults', () => {
    const configuration = resolveServerConfiguration({
      SOMNIO_HTTP_HOST: '10.0.0.5',
      SOMNIO_HTTP_PORT: '9001',
      SOMNIO_ADMIN_TOKEN: 'production-secret',
      SOMNIO_SECTORS_DIR: '/srv/somnio/maps',
    });
    expect(configuration.httpHost).toBe('10.0.0.5');
    expect(configuration.httpPort).toBe(9001);
    expect(configuration.adminToken).toBe('production-secret');
    expect(configuration.sectorsDirectory).toBe('/srv/somnio/maps');
    expect(configuration.devDefaults).toBe(false);
  });

  it('SOMNIO_DEV_DEFAULTS=1 with an empty environment falls back to dev defaults', () => {
    const configuration = resolveServerConfiguration({ SOMNIO_DEV_DEFAULTS: '1' });
    expect(configuration.httpHost).toBe(DEFAULT_HTTP_HOST);
    expect(configuration.httpPort).toBe(DEFAULT_HTTP_PORT);
    expect(configuration.adminToken).toBe(DEV_ADMIN_TOKEN);
    expect(configuration.sectorsDirectory.endsWith('packages/core/fixtures/sectors')).toBe(true);
    expect(configuration.devDefaults).toBe(true);
  });

  it('no admin token without dev defaults throws missingAdminToken', () => {
    expect(kindOf(() => resolveServerConfiguration({ SOMNIO_SECTORS_DIR: '/srv/maps' }))).toBe('missingAdminToken');
  });

  it('unset SOMNIO_DEV_DEFAULTS with a missing token refuses', () => {
    expect(kindOf(() => resolveServerConfiguration({}))).toBe('missingAdminToken');
  });

  /** The opt-in gates the well-known admin token, so every non-opting spelling is pinned, not only absence. */
  it.each(['', '0', 'false', 'no', 'yes'])('SOMNIO_DEV_DEFAULTS=%j does not opt in', (raw) => {
    expect(kindOf(() => resolveServerConfiguration({ SOMNIO_DEV_DEFAULTS: raw }))).toBe('missingAdminToken');
  });

  it.each(['true', 'TRUE', 'True'])('SOMNIO_DEV_DEFAULTS=%s opts in like 1', (raw) => {
    expect(resolveServerConfiguration({ SOMNIO_DEV_DEFAULTS: raw }).devDefaults).toBe(true);
  });

  it('no sectors dir without dev defaults throws missingSectorsDirectory', () => {
    expect(kindOf(() => resolveServerConfiguration({ SOMNIO_ADMIN_TOKEN: 'secret' }))).toBe('missingSectorsDirectory');
  });

  it('non-numeric port throws invalidPort', () => {
    expect(kindOf(() => resolveServerConfiguration({ SOMNIO_DEV_DEFAULTS: '1', SOMNIO_HTTP_PORT: 'not-a-port' }))).toBe('invalidPort');
  });

  it.each(['0', '65536', '-1', '70000', '1.5'])('out-of-range port %s throws invalidPort', (raw) => {
    expect(kindOf(() => resolveServerConfiguration({ SOMNIO_DEV_DEFAULTS: '1', SOMNIO_HTTP_PORT: raw }))).toBe('invalidPort');
  });

  it('empty admin token without dev defaults is rejected as missing', () => {
    expect(kindOf(() => resolveServerConfiguration({ SOMNIO_ADMIN_TOKEN: '', SOMNIO_SECTORS_DIR: '/srv/maps' }))).toBe('missingAdminToken');
  });

  it.each(['1', 'true', 'TRUE', 'True'])('truthy SOMNIO_DIALOG_PRUNE_FORCE=%s resolves forceDialogPrune true', (raw) => {
    const configuration = resolveServerConfiguration({
      SOMNIO_DEV_DEFAULTS: '1',
      SOMNIO_DIALOG_PRUNE_FORCE: raw,
    });
    expect(configuration.forceDialogPrune).toBe(true);
  });

  it.each(['', '0', 'false', 'no', 'yes'])('non-truthy SOMNIO_DIALOG_PRUNE_FORCE=%j resolves forceDialogPrune false', (raw) => {
    const configuration = resolveServerConfiguration({
      SOMNIO_DEV_DEFAULTS: '1',
      SOMNIO_DIALOG_PRUNE_FORCE: raw,
    });
    expect(configuration.forceDialogPrune).toBe(false);
  });

  it('absent SOMNIO_DIALOG_PRUNE_FORCE defaults forceDialogPrune false', () => {
    expect(resolveServerConfiguration({ SOMNIO_DEV_DEFAULTS: '1' }).forceDialogPrune).toBe(false);
  });
});
