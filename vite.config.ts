import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import path from 'path';
import { execSync } from 'child_process';
import fs from 'fs';

// Get version from environment, git tag, or package.json
function getVersion(): string {
  // 1. Environment variable (set by GitHub Actions)
  if (process.env.VERSION) {
    return process.env.VERSION;
  }

  // 2. Try git tag. Keep this shell-portable; Windows cmd does not understand
  // POSIX-style stderr redirects and `|| echo ""` the same way.
  for (const command of ['git describe --tags --exact-match', 'git describe --tags']) {
    try {
      const gitTag = execSync(command, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (gitTag) {
        return gitTag;
      }
    } catch {
      // Try the next fallback.
    }
  }

  // 3. Fall back to package.json version
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'));
    if (pkg.version && pkg.version !== '0.0.0') {
      return pkg.version;
    }
  } catch {
    // package.json not readable
  }

  return 'dev';
}

const appVersion = getVersion();
const customUiBuildId =
  process.env.CUSTOM_UI_BUILD_ID ||
  `${appVersion}-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'custom-ui-build-id',
      transformIndexHtml() {
        return [
          {
            tag: 'meta',
            attrs: {
              name: 'custom-ui-build-id',
              content: customUiBuildId,
            },
            injectTo: 'head',
          },
        ];
      },
    },
    viteSingleFile({
      removeViteModuleLoader: true
    })
  ],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __CUSTOM_UI_BUILD_ID__: JSON.stringify(customUiBuildId)
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  },
  css: {
    modules: {
      localsConvention: 'camelCase',
      generateScopedName: '[name]__[local]___[hash:base64:5]'
    },
    preprocessorOptions: {
      scss: {
        additionalData: `@use "@/styles/variables.scss" as *;`
      }
    }
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
    assetsInlineLimit: 100000000,
    chunkSizeWarningLimit: 100000000,
    cssCodeSplit: false,
    rolldownOptions: {
      output: {
        codeSplitting: false
      }
    }
  }
});
