import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    react: 'src/adapters/react/index.ts',
    vue: 'src/adapters/vue/index.ts',
    sync: 'src/sync.ts',
    'sync-react': 'src/adapters/react/sync.ts',
    'sync-vue': 'src/adapters/vue/sync.ts',
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
