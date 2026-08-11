Place the Auth0 SPA SDK locally if external CDNs are blocked.

Steps:
1. Download ONE of the following VALID versions (newest first):
   - https://cdn.auth0.com/js/auth0-spa-js/2.7/auth0-spa-js.production.js
   - https://cdn.auth0.com/js/auth0-spa-js/2.6/auth0-spa-js.production.js
   - https://cdn.auth0.com/js/auth0-spa-js/2.5/auth0-spa-js.production.js
   - https://cdn.auth0.com/js/auth0-spa-js/2.0/auth0-spa-js.production.js
   (Earlier 2.5.3 URL referenced previously was invalid and returned 404/HTML.)
2. Save the file as:
   frontend/vendor/auth0/auth0-spa-js.production.js
3. Do NOT modify its contents.
4. Reload the site. The loader will attempt the local path after public CDNs.

Security tip: Verify the downloaded file integrity (hash) if possible before hosting it.

This file is only documentation; you still need to create the 'auth0' folder and add the script file inside it.