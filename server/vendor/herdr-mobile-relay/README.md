# Extracted workspace inspector

Source: https://github.com/benkraus/herdr-plugin-mobile-relay
Pinned revision: 0195d7d959df5d7df163cf1e25c598aaab9720ef

`server/src/backend/workspace-inspection.ts` and `inspection-types.ts` are extracted from `bridge/workspace-inspection.ts` and the corresponding interfaces in `bridge/types.ts`. `server/test/backend-inspection.test.ts` is extracted from `bridge/workspace-inspection.test.ts`. Copyright (c) 2026 Altan Sarisin, MIT. The full license is included here. Local modifications change the import and add provenance; the containment checks, bounded subprocesses, Git environment hardening, and file identity checks are retained. There is no runtime dependency on the research checkout.
