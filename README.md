# poolhelp.app

Product site for PoolHelp (iOS). Static HTML, deployed on Vercel.

- `/` marketing page · `/privacy` · `/terms` · `/safety` · `/support`
- Legal pages are GENERATED from the app repo's markdown (the same text the
  app renders in-app). To update: edit `PRIVACY.md` / `TERMS.md` / `SAFETY.md`
  in the PoolHelp repo, then `python3 scripts/build-legal.py ../PoolHelp`,
  commit, push — Vercel redeploys.
- Screenshots in `assets/img` come from the App Store screenshot set.
