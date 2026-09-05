import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/**
 * The workspace's package graph, enforced on `packages/<name>/src/**` only, so a test file may
 * take a `devDependency` outside it. Each entry lists what the package may import; the rule bans
 * the complement.
 */
const PACKAGES = ['protocol', 'core', 'data', 'server', 'cli', 'web']
/** @type {Record<string, string[]>} */
const ALLOWED_IMPORTS = {
  protocol: [],
  core: ['protocol'],
  data: ['core'],
  server: ['protocol', 'core', 'data'],
  cli: ['protocol', 'core'],
  web: ['protocol', 'core'],
}

const boundaryRules = PACKAGES.map((name) => ({
  files: [`packages/${name}/src/**/*.ts`],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: PACKAGES.filter((other) => other !== name && !ALLOWED_IMPORTS[name]?.includes(other)).map(
          (other) => ({
            group: [`@somnio/${other}`, `@somnio/${other}/*`],
            message: `@somnio/${name} must not import @somnio/${other}`,
          })
        ),
      },
    ],
  },
}))

export default tseslint.config(
  // Only the npm workspace is linted. The standalone `.mjs` scripts sit outside every tsconfig,
  // so the type-checked preset cannot resolve them; skills and docs carry no source.
  {
    ignores: [
      '**/dist',
      '**/node_modules',
      'coverage',
      'packages/web/public',
      'packages/*/scripts',
      'Scripts',
      '.husky',
      'Skills',
      'Docs',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // This config file is itself JS, so it is outside every tsconfig's TS-only `include` and
        // the project service would otherwise refuse to parse it.
        projectService: { allowDefaultProject: ['eslint.config.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Off workspace-wide: the protocol validators narrow `unknown` deliberately, and the
      // type-checked preset's blanket bans on unsafe member access would fire on every field probe.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/consistent-type-imports': 'error',
      // A leading underscore marks a parameter a stub keeps only to match its interface's arity.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['packages/*/test/**/*.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  ...boundaryRules
)
