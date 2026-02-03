#!/usr/bin/env node

/**
 * Security Audit Script for Admin Endpoints
 * 
 * This script scans all admin route files and verifies that:
 * 1. All admin endpoints use the adminAuth middleware
 * 2. Documents any intentional exceptions
 * 3. Generates a comprehensive security audit report
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ADMIN_ROUTES_DIR = join(__dirname, '../server/routes/admin');

// Known intentional exceptions (endpoints that should NOT have adminAuth)
const INTENTIONAL_EXCEPTIONS = [
  '/api/admin/auth/status' // Public endpoint to check auth requirements
];

function extractRoutes(filePath, fileName) {
  const content = readFileSync(filePath, 'utf-8');
  const routes = [];
  
  // Match route definitions: app.METHOD(buildServerPath('PATH', basePath), ...)
  const routeRegex = /app\.(get|post|put|delete|patch)\(\s*buildServerPath\(['"]([^'"]+)['"]/g;
  // Alternative pattern: app.METHOD(`${basePath}/PATH`, ...)
  const altRouteRegex = /app\.(get|post|put|delete|patch)\(\s*`\$\{basePath\}([^`]+)`/g;
  
  let match;
  
  // Extract routes with buildServerPath
  while ((match = routeRegex.exec(content)) !== null) {
    const method = match[1].toUpperCase();
    const path = match[2];
    
    // Get the line number
    const lineNumber = content.substring(0, match.index).split('\n').length;
    
    // Get context around the route (check up to 10 lines after the route definition)
    const lines = content.split('\n');
    const contextStart = lineNumber - 1;
    const contextEnd = Math.min(contextStart + 10, lines.length);
    const context = lines.slice(contextStart, contextEnd).join('\n');
    
    // Check if adminAuth is in the context
    const hasAdminAuth = context.includes('adminAuth');
    
    routes.push({
      file: fileName,
      method,
      path,
      lineNumber,
      hasAdminAuth,
      isException: INTENTIONAL_EXCEPTIONS.includes(path)
    });
  }
  
  // Extract routes with template literals
  while ((match = altRouteRegex.exec(content)) !== null) {
    const method = match[1].toUpperCase();
    const path = match[2];
    
    // Get the line number
    const lineNumber = content.substring(0, match.index).split('\n').length;
    
    // Get context around the route
    const lines = content.split('\n');
    const contextStart = lineNumber - 1;
    const contextEnd = Math.min(contextStart + 10, lines.length);
    const context = lines.slice(contextStart, contextEnd).join('\n');
    
    // Check if adminAuth is in the context
    const hasAdminAuth = context.includes('adminAuth');
    
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

function auditAdminRoutes() {
  console.log('🔍 Starting Admin Endpoints Security Audit\n');
  console.log('=' .repeat(80));
  
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
  
  console.log('=' .repeat(80));
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
