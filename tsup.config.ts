import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    react: 'src/adapters/react.ts',
    vue: 'src/adapters/vue.ts',
    sync: 'src/sync.ts',
    'sync-react': 'src/adapters/sync-react.ts',
    'sync-vue': 'src/adapters/sync-vue.ts',
  },
  format: ['esm', 'cjs'],
  dts: false,
  clean: true,
  sourcemap: true,
  splitting: true,
  external: ['react', 'vue'],
  banner: (ctx) => {
    if (ctx.format === 'esm') return {};
    return {};
  },
});
