import { defineConfig, type PluginOption, type ResolvedConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { join, resolve } from 'path'
import {
  cpSync,
  rmSync,
  linkSync,
  readdirSync,
  statSync,
  createWriteStream,
  mkdirSync,
  writeFileSync,
  renameSync,
} from 'fs'
import archiver from 'archiver'
import randomstring from 'randomstring'
import manifestJson from './manifest.json'
import packageJson from './package.json'
import { locales } from './src/i18n/locales'
import ManifestV3 = chrome.runtime.ManifestV3

const distDir = resolve(__dirname, 'dist')
const distChromeDir = join(distDir, 'chrome')
const distFireFoxDir = join(distDir, 'firefox')
const srcDir = resolve(__dirname, 'src')
const entrypointDir = join(srcDir, 'entrypoints')
const staticDir = resolve(__dirname, 'static')

const uniqueInjectFileName: string = randomstring.generate({ length: 8, charset: 'alphabetic' })
const uniqueHeaderKeyName: string = randomstring.generate({ length: 8, charset: 'alphabetic' })

enum ProjectURLs {
  GITHUB = 'https://github.com/tarampampam/random-user-agent',
  BUGREPORT = 'https://github.com/tarampampam/random-user-agent/issues/new/choose',
  CHROME = 'https://chromewebstore.google.com/detail/random-user-agent-switche/einpaelgookohagofgnnkcfjbkkgepnp',
  FIREFOX = 'https://addons.mozilla.org/firefox/addon/random_user_agent',
  OPERA = 'https://addons.opera.com/extensions/details/random-user-agent',
  MICROSOFT = 'https://microsoftedge.microsoft.com/addons/detail/random-useragent-switch/addfjgllfhpnacoahmmcafmaacjloded',
}

const outputBanner = `
/**
 * Hey there! 👋 Nothing to hide from your scrutiny, right? 😆 This file is
 * part of the Random User-Agent extension, essential for enhancing your
 * anonymity online (not by much, but still).
 *
 * If you encounter any issues, please feel free to file a new issue here:
 *
 * \t${ProjectURLs.BUGREPORT}
 */`.trim()

/** Create _locales directory with messages.json files */
const createLocalesPlugin: PluginOption = {
  name: 'create-locale-files',
  generateBundle() {
    for (const locale in locales) {
      const name = locale as keyof typeof locales
      const data = locales[name]
      const result: Record<string, { message: string }> = {}

      for (const key in data) {
        result[key] = { message: data[key as keyof typeof data] }
      }

      const dirPath = join(distChromeDir, '_locales', name)

      mkdirSync(dirPath, { recursive: true })
      writeFileSync(join(dirPath, 'messages.json'), JSON.stringify(result), { flag: 'w' })
    }
  },
}

/** Copy static content as is */
const copyStaticContentAsIsPlugin: PluginOption = {
  name: 'copy-static-content',
  generateBundle() {
    cpSync(staticDir, distChromeDir, { recursive: true })
  },
}

/** Rename inject.js file to a unique name */
const renameInjectFilePlugin: PluginOption = {
  name: 'rename-inject-file',
  writeBundle() {
    const from = join(distChromeDir, 'inject.js')
    const to = join(distChromeDir, `${uniqueInjectFileName}.js`)

    renameSync(from, to)
  },
}

/** Split dist into chrome and firefox */
const splitChromeAndFirefoxPlugin: PluginOption = {
  name: 'split-chrome-and-firefox',
  writeBundle: {
    sequential: true,
    handler() {
      rmSync(distFireFoxDir, { recursive: true, force: true })
      mkdirSync(distFireFoxDir, { recursive: true })

      const mirror = (from: string, to: string): void => {
        readdirSync(from, { withFileTypes: true })
          .sort()
          .forEach((file) => {
            if (file.name === 'manifest.json') {
              return
            }

            const fromPath = join(from, file.name)
            const toPath = join(to, file.name)
            const stat = statSync(fromPath)

            if (stat.isDirectory()) {
              mkdirSync(toPath, { recursive: true })
              mirror(fromPath, toPath)
            } else if (stat.isFile() || stat.isSymbolicLink()) {
              linkSync(fromPath, toPath)
            }
          })
      }

      mirror(distChromeDir, distFireFoxDir)
    },
  },
}

/** Create manifest.json file with version from package.json (including other changes) */
const copyAndModifyManifestPlugin: PluginOption = {
  name: 'copy-and-modify-manifest',
  writeBundle: {
    sequential: true,
    handler() {
      const content: Partial<Omit<ManifestV3, 'version'> & { version: string }> = {
        ...manifestJson,
      }

      for (const key in content) {
        if (key.startsWith('$')) {
          delete content[key as keyof typeof content]
        }
      }

      content.version = packageJson.version
      content.web_accessible_resources = [{ resources: [`/${uniqueInjectFileName}.js`], matches: ['<all_urls>'] }]

      writeFileSync(join(distChromeDir, 'manifest.json'), JSON.stringify(content), { flag: 'w' })

      writeFileSync(
        join(distFireFoxDir, 'manifest.json'),
        JSON.stringify({
          ...content,
          background: { scripts: [content.background.service_worker], type: content.background.type },
          browser_specific_settings: {
            gecko: { strict_min_version: '113.0', id: '{b43b974b-1d3a-4232-b226-eaa2ac6ebb69}' },
            gecko_android: { strict_min_version: '120.0' },
          },
        }),
        { flag: 'w' }
      )
    },
  },
}

/** Create dist.zip file */
const zipDistPlugin = (): PluginOption => {
  let config: ResolvedConfig

  return {
    name: 'zip-dist',
    configResolved(cfg) {
      config = cfg
    },
    writeBundle: {
      sequential: true,
      async handler() {
        if (config.command !== 'build' || process.argv.includes('--watch')) {
          return
        }

        {
          const archive = archiver('zip', { zlib: { level: 9 } })

          archive.pipe(createWriteStream(resolve(distDir, 'chrome.zip')))
          archive.directory(distChromeDir, false)

          await archive.finalize()
        }

        {
          const archive = archiver('zip', { zlib: { level: 9 } })

          archive.pipe(createWriteStream(resolve(distDir, 'firefox.zip')))
          archive.directory(distFireFoxDir, false)

          await archive.finalize()
        }
      },
    },
  }
}

export default defineConfig({
  plugins: [
    react(),
    [createLocalesPlugin, copyStaticContentAsIsPlugin, renameInjectFilePlugin],
    splitChromeAndFirefoxPlugin,
    [copyAndModifyManifestPlugin, zipDistPlugin()],
  ],
  resolve: {
    alias: {
      '~': srcDir,
    },
  },
  define: {
    __UNIQUE_INJECT_FILENAME__: JSON.stringify(`${uniqueInjectFileName}.js`),
    __UNIQUE_HEADER_KEY_NAME__: JSON.stringify(uniqueHeaderKeyName),

    __GITHUB_URL__: JSON.stringify(ProjectURLs.GITHUB),
    __BUGREPORT_URL__: JSON.stringify(ProjectURLs.BUGREPORT),
    __CHROME_STORE_URL__: JSON.stringify(ProjectURLs.CHROME),
    __MOZILLA_STORE_URL__: JSON.stringify(ProjectURLs.FIREFOX),
    __OPERA_STORE_URL__: JSON.stringify(ProjectURLs.OPERA),
    __MICROSOFT_STORE_URL__: JSON.stringify(ProjectURLs.MICROSOFT),
  },
  root: entrypointDir,
  assetsInclude: 'public/**/*',
  build: {
    outDir: distChromeDir,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: join(entrypointDir, 'popup', 'index.html'),
        options: join(entrypointDir, 'options', 'index.html'),
        onboard: join(entrypointDir, 'onboard', 'index.html'),
        background: join(entrypointDir, 'background', 'index.ts'),
        content: join(entrypointDir, 'content', 'content.ts'),
        inject: join(entrypointDir, 'content', 'inject.ts'),
      },
      output: {
        banner: outputBanner,
        entryFileNames: '[name].js',
        chunkFileNames: 'js/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
    sourcemap: process.argv.includes('--watch'),
  },
  // @ts-ignore-next-line The `vite` type definitions are not up-to-date
  test: {
    root: __dirname,
  },
})
