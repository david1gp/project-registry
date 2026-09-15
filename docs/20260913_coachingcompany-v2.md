# Goal
Extend project-creator and set up coachingcompany-v2 on leo@leo-server in ~/projects/coachingcompany-v2 using the default profile; verify development and production deployments, DNS and TLS.

# Decisions
- Preserve the existing dirty ~/adaptive/project-creator checkout. Implement and install from a separate current-upstream checkout.
- Pass all six domains through CLI flags. Add --preview-api-domain and --preview-convex-domain, retaining existing defaults.
- Recipe steps must save environment-specific URLs to actual .env.development and .env.production, preserving secrets and unrelated settings.
- Development: https://coachingcompany.leonardomora.de, https://coachingcompany-convex.leonardomora.de, https://coachingcompany-api.leonardomora.de.
- Production: https://coachingcompany.contentoren.de, https://coachingcompany-convex.contentoren.de, https://coachingcompany-api.contentoren.de.
- Use existing libraries; tests run with maximum concurrency 1, without watch mode.
- Switch the existing development site hostname to v2 with user approval; preserve the old project and data.

# Approach
Extend and test CLI domain propagation, then recipe environment writes. Install the verified CLI separately, execute the requested recipe with explicit domains and default profile, then deploy and verify development and production using existing infrastructure.

# Tasks
1. Completed: implement and test explicit development API/Convex domain flags throughout CLI/configuration/recipe context.
2. Completed: implement and test actual environment-file recipe writes.
3. Completed: verify and install updated CLI; create project with the user command plus six explicit domain arguments.
4. Completed: configure and verify development deployment.
5. Completed: configure and verify production deployment, DNS and TLS for all six hosts; browser-check the sites.

Creation command (append explicit domain arguments):
`project-creator --non-interactive --targets backend,cli,library,web,webapp --name coachingcompany-v2 --profile default --section Kunden --visibility public --backend convex --web-rendering ssr --feature content --feature www-redirect --language de --capability assets-service --capability cloudflare-pages --capability convex-self-hosted --capability prodctl --capability project-registry-docs --capability solid-ui`
