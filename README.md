# Ferry

Upload PDFs on one computer, download on another.

## Deploy (Netlify)
1. Push this folder to a GitHub repo (or use `netlify deploy --prod` from CLI).
2. Netlify > New site > import repo. Build settings auto read from netlify.toml.
3. Site settings > Environment variables > add `VAULT_PASSCODE` = your secret.
4. Redeploy. Open site, enter passcode.

Drag and drop deploy of a plain folder will NOT work: needs function + dependency build.

## Notes
- Files stored in Netlify Blobs, chunked 4 MB, max 200 MB each.
- Delete files after download.
