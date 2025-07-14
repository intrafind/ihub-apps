import {
  createLink,
  getLink,
  recordUsage,
  deleteLink,
  updateLink,
  searchLinks,
  isLinkExpired,
} from "../shortLinkManager.js";

export default function registerShortLinkRoutes(app) {
  app.post("/api/shortlinks", async (req, res) => {
    try {
      const {
        code,
        appId,
        userId,
        path,
        params,
        url,
        includeParams,
        expiresAt,
      } = req.body;
      if (!url && !appId && !path) {
        return res.status(400).json({ error: "appId or url or path required" });
      }
      const link = await createLink({
        code,
        appId,
        userId,
        path,
        params,
        url,
        includeParams,
        expiresAt,
      });
      res.json(link);
    } catch (e) {
      if (e.message === "Code already exists") {
        return res.status(409).json({ error: "Code already exists" });
      }
      console.error("Error creating short link:", e);
      res.status(500).json({ error: "Failed to create short link" });
    }
  });

  app.get("/api/shortlinks", async (req, res) => {
    try {
      const { appId, userId } = req.query;
      const links = await searchLinks({ appId, userId });
      res.json(links);
    } catch (e) {
      console.error("Error fetching short links:", e);
      res.status(500).json({ error: "Failed to fetch short links" });
    }
  });

  app.get("/api/shortlinks/:code", async (req, res) => {
    try {
      const link = await getLink(req.params.code);
      if (!link) return res.status(404).json({ error: "Not found" });
      res.json(link);
    } catch (e) {
      console.error("Error fetching short link:", e);
      res.status(500).json({ error: "Failed to fetch short link" });
    }
  });

  app.put("/api/shortlinks/:code", async (req, res) => {
    try {
      const link = await updateLink(req.params.code, req.body);
      if (!link) return res.status(404).json({ error: "Not found" });
      res.json(link);
    } catch (e) {
      console.error("Error updating short link:", e);
      res.status(500).json({ error: "Failed to update short link" });
    }
  });

  app.delete("/api/shortlinks/:code", async (req, res) => {
    try {
      const ok = await deleteLink(req.params.code);
      if (!ok) return res.status(404).json({ error: "Not found" });
      res.json({ success: true });
    } catch (e) {
      console.error("Error deleting short link:", e);
      res.status(500).json({ error: "Failed to delete short link" });
    }
  });

  app.get("/s/:code", async (req, res) => {
    try {
      const link = await recordUsage(req.params.code);
      if (!link) return res.status(404).send("Not found");
      if (isLinkExpired(link)) {
        return res.status(410).send("This short link has expired");
      }
      res.redirect(link.url);
    } catch (e) {
      console.error("Error redirecting short link:", e);
      res.status(500).send("Error");
    }
  });
}
