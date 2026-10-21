import { defineConfig } from 'vitest/config';
import { version } from './scripts/version.ts';

export default defineConfig(({ command }) => {
  const v = version(command !== 'build');
  if (v.dirty) console.warn(`\nBuilding with changes that are not committed: the corner says ${v.label}, but this build is not commit ${v.sha.slice(0, 12)}.\n`);
  return {
    // The build, as the game's version for p3p2 (scripts/version.ts).
    define: { __BUILD__: JSON.stringify(v.build) },
    // The p3p2 client is served as the files it is made of, on the dev server too: its small entry on every visit,
    // and the rest only when a room is opened.
    optimizeDeps: { exclude: ['@p3p2/client'] },
    plugins: [
      {
        // The version in the corner is in the HTML itself, there at first paint.
        name: 'version',
        transformIndexHtml: (html: string) => html.replaceAll('%APP_VERSION%', v.label),
      },
    ],
    build: {
      target: 'es2022',
      modulePreload: { polyfill: false },
      assetsInlineLimit: 8192,
    },
    test: {
      include: ['tests/unit/**/*.test.ts'],
    },
  };
});
