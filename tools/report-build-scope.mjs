// Informational build scope only. This never issues readiness evidence.
console.log('BUILD-CANDIDATE SCOPE ONLY: dist builds and checks a candidate; success is NOT full release qualification.')
console.log('Full qualification requires release:qualify and its registered exact-artifact qualification adapters; an existing trusted receipt may be supplied with --readiness-evidence.')
console.log('Receipt-producing cuts require --readiness-output in an existing private evidence directory; only the original private receipt may authorize publication.')
