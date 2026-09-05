// Hook installation, skipped wherever hooks make no sense: CI, and the image builds, whose
// `npm ci --omit=dev` never installs husky in the first place (a bare `"prepare": "husky"`
// would fail that install with "command not found").
if (process.env.CI !== undefined || process.env.NODE_ENV === 'production') process.exit(0)
let husky
try {
  husky = (await import('husky')).default
} catch {
  process.exit(0)
}
console.log(husky())
