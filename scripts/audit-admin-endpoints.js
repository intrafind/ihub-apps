#!/usr/bin/env node

/**
 * Security Audit Script for Admin Endpoints
 *
 * This script scans all admin route files and verifies that:
 * 1. Every admin endpoint is guarded by an admin middleware (ADMIN_GUARD_PATTERN)
 * 2. Documents any intentional exceptions
 * 3. Generates a comprehensive security audit report
 *
 * Exits non-zero when an unguarded endpoint is found, so CI can run it
 * (.github/workflows/security.yml).
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ADMIN_ROUTES_DIR = join(__dirname, '../server/routes/admin');

// Middleware that restricts a route to administrators. contentAdminAuth also
// admits groups with the delegated contentAdmin permission (apps, prompts,
// sources, skills) and rejects anonymous and machine principals.
const ADMIN_GUARD_PATTERN = /\b(adminAuth|contentAdminAuth)\b/;

// Known intentional exceptions (endpoints that should NOT have adminAuth)
const INTENTIONAL_EXCEPTIONS = [
  '/api/admin/auth/status' // Public endpoint to check auth requirements
];

/** Every route registered in |filePath|, with whether an admin guard protects it. */
function extractRoutes(filePath, fileName) {
  const content = readFileSync(filePath, 'utf-8');
  const routes = [];

  // Every app.METHOD(<path>, ...middleware, handler) registration, whatever
  // form the path takes: buildServerPath('...'), `${basePath}/...`, or a
  // variable such as `${base}/:id`. (?<![.\w]) skips req.app.get('platform').
  const routeRegex = /(?<![.\w])app\.(get|post|put|delete|patch)\(\s*([^,\s][^,]*),/g;

  let match;
  while ((match = routeRegex.exec(content)) !== null) {
    const method = match[1].toUpperCase();
    const pathArg = match[2].trim();
    const path =
      /^buildServerPath\(\s*['"]([^'"]+)['"]\s*\)$/.exec(pathArg)?.[1] ??
      /^`\$\{basePath\}([^`]+)`$/.exec(pathArg)?.[1] ??
      pathArg;

    const lineNumber = content.substring(0, match.index).split('\n').length;

    // The middleware list runs from the path to the handler; only a guard
    // named there protects the route (not one mentioned in a later comment).
    const rest = content.slice(match.index + match[0].length);
    const handlerStart = rest.search(/(async\s*)?\(\s*req\b|(async\s+)?function\b/);
    const middleware = handlerStart === -1 ? rest.slice(0, 500) : rest.slice(0, handlerStart);
    const hasAdminAuth = ADMIN_GUARD_PATTERN.test(middleware);

    routes.push({
      file: fileName,
      method,
      path,
      lineNumber,
      hasAdminAuth,
      isException: INTENTIONAL_EXCEPTIONS.includes(path)
    });
  }

  return routes;
}

/** Audits every admin route file, prints a report and exits 1 on an unguarded route. */
function auditAdminRoutes() {
  console.log('🔍 Starting Admin Endpoints Security Audit\n');
  console.log('='.repeat(80));

  const files = readdirSync(ADMIN_ROUTES_DIR).filter(f => f.endsWith('.js'));

  let totalRoutes = 0;
  let protectedRoutes = 0;
  let unprotectedRoutes = 0;
  let exceptions = 0;

  const vulnerabilities = [];
  const allRoutes = [];

  // Analyze each file
  files.forEach(fileName => {
    const filePath = join(ADMIN_ROUTES_DIR, fileName);
    const routes = extractRoutes(filePath, fileName);

    routes.forEach(route => {
      totalRoutes++;
      allRoutes.push(route);

      if (route.isException) {
        exceptions++;
        console.log(`✓ [EXCEPTION] ${route.method} ${route.path}`);
        console.log(`  File: ${route.file}:${route.lineNumber}`);
        console.log(`  Reason: Intentionally public (auth status check)\n`);
      } else if (route.hasAdminAuth) {
        protectedRoutes++;
      } else {
        unprotectedRoutes++;
        vulnerabilities.push(route);
        console.log(`❌ [VULNERABILITY] ${route.method} ${route.path}`);
        console.log(`  File: ${route.file}:${route.lineNumber}`);
        console.log(`  Issue: Missing adminAuth middleware\n`);
      }
    });
  });

  console.log('='.repeat(80));
  console.log('\n📊 Security Audit Summary\n');
  console.log(`Total Admin Endpoints: ${totalRoutes}`);
  console.log(`✅ Protected Endpoints: ${protectedRoutes}`);
  console.log(`⚠️  Intentional Exceptions: ${exceptions}`);
  console.log(`❌ Unprotected Endpoints: ${unprotectedRoutes}`);
  console.log('');

  if (vulnerabilities.length > 0) {
    console.log('🚨 SECURITY VULNERABILITIES FOUND!\n');
    console.log('The following endpoints are missing adminAuth middleware:\n');
    vulnerabilities.forEach(v => {
      console.log(`  - ${v.method} ${v.path} (${v.file}:${v.lineNumber})`);
    });
    console.log('\n⚠️  These endpoints may allow unauthorized access to admin functionality!');
    process.exit(1);
  } else {
    console.log('✅ All admin endpoints are properly protected!');
    console.log(`   ${protectedRoutes} endpoints with adminAuth middleware`);
    console.log(`   ${exceptions} documented exceptions`);
    console.log('\n🔒 Security Audit: PASSED');
    process.exit(0);
  }
}

// Run the audit
auditAdminRoutes();
