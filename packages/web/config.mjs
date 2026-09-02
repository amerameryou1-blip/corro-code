const stage = process.env.SST_STAGE || "dev"

export default {
  url: stage === "production" ? "https://corrocode.dev" : `https://${stage}.opencode.ai`,
  console: stage === "production" ? "https://corrocode.dev/auth" : `https://${stage}.opencode.ai/auth`,
  email: "help@anoma.ly",
  socialCard: "https://social-cards.sst.dev",
  github: "https://github.com/anomalyco/opencode",
  discord: "https://corrocode.dev/discord",
  headerLinks: [
    { name: "app.header.home", url: "/" },
    { name: "app.header.docs", url: "/docs/" },
  ],
}
