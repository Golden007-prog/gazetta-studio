import { cloudflareWorkersDeploy, defineSite, filesystemStorage, r2Storage } from 'gazetta'

export default defineSite({
  name: 'Gazetta Studio',
  locales: { default: 'en', supported: ['en'] },
  targets: {
    local: {
      // Relative paths are anchored to this config file's directory.
      storage: filesystemStorage({ path: './targets/local' }),
      // The editing target: keeps history, so its storage must be private.
      publicStorage: false,
      // Defaults: environment=local (editable)
    },
    ci: {
      // CI renders the site here so a change that breaks it fails the PR
      // (.github/workflows/ci.yml). Never deployed; gitignored under dist/.
      storage: filesystemStorage({ path: './dist/ci' }),
      publicStorage: false,
      editable: false,
    },
    production: {
      type: 'dynamic',
      // The bucket has no public access; visitors reach it only through the worker.
      publicStorage: false,
      storage: r2Storage({
        accountId: '30ec7440a8cdafa137c993cd4a0f4c67',
        bucket: 'gazetta-studio-site',
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      }),
      // Constructed only when CLOUDFLARE_API_TOKEN is set; allows
      // local dev without the token. `gazetta deploy production` will
      // surface the missing-deploy-adapter error in that case, which
      // is the right operator UX.
      deploy: process.env.CLOUDFLARE_API_TOKEN
        ? cloudflareWorkersDeploy({
            apiToken: process.env.CLOUDFLARE_API_TOKEN,
            accountId: '30ec7440a8cdafa137c993cd4a0f4c67',
            name: 'gazetta-studio',
            bucket: 'gazetta-studio-site',
          })
        : undefined,
      environment: 'production',
      siteUrl: 'https://gazetta.studio',
      cache: {
        browser: 0,
        edge: 86400,
        purge: {
          type: 'cloudflare',
          apiToken: process.env.CLOUDFLARE_API_TOKEN!,
        },
      },
    },
  },
})
