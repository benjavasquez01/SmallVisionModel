const path = require('path');

module.exports = {
  webpack: {
    configure: (webpackConfig) => {
      console.log('🔧 CRACO: Configuring webpack...');
      console.log(`📍 Environment: ${process.env.NODE_ENV}`);
      console.log(`📦 Node Version: ${process.version}`);

      // Browser polyfill fallbacks
      webpackConfig.resolve.fallback = {
        ...webpackConfig.resolve.fallback,
        fs: false,
        path: false,
        crypto: false,
        os: false,
      };
      console.log('✅ CRACO: Added resolve fallbacks');

      // Handle node: protocol imports (used by newer packages)
      const webpack = require('webpack');
      webpackConfig.plugins.push(
        new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
          resource.request = resource.request.replace(/^node:/, '');
        })
      );
      console.log('✅ CRACO: Added node: protocol handler');

      // Ignore noisy warnings from transformers.js / onnxruntime
      webpackConfig.ignoreWarnings = [
        /Critical dependency: the request of a dependency is an expression/,
        /Critical dependency: 'import.meta' cannot be used/,
        /Critical dependency: require function is used in a way/,
      ];

      // WASM files — served as static assets (required by onnxruntime-web)
      webpackConfig.module.rules.push({
        test: /\.wasm$/,
        type: 'asset/resource',
      });
      console.log('✅ CRACO: Added WASM asset rule');

      // Exclude server-only onnxruntime from the browser bundle
      webpackConfig.externals = {
        ...webpackConfig.externals,
        'onnxruntime-node': 'onnxruntime-node',
      };

      // Alias onnxruntime-web to WASM-only build (no WebGPU dependency)
      const ortWasmPath = path.resolve(
        __dirname,
        'node_modules/onnxruntime-web/dist/ort.wasm.min.js'
      );
      webpackConfig.resolve.alias = {
        ...webpackConfig.resolve.alias,
        'onnxruntime-web': ortWasmPath,
      };
      console.log(`✅ CRACO: Aliased onnxruntime-web → ort.wasm.min.js`);

      console.log('🎉 CRACO: Webpack configuration complete');
      return webpackConfig;
    },
  },
  devServer: {
    headers: {
      // Required for SharedArrayBuffer (multi-threaded WASM) and camera access
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
      // CSP intentionally omitted in dev — CRA dev build uses eval for source maps.
      // Production CSP (wasm-unsafe-eval) is enforced via netlify.toml and public/_headers.
    },
  },
};
