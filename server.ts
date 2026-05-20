import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import cors from "cors";

// Load .env variables
dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());
  app.use(cors());

  // API Route for sending emails
  app.post("/api/send-email", async (req, res) => {
    const { to, subject, html } = req.body;

    if (!to || !subject || !html) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    try {
      // Check for Microsoft Graph API credentials
      if (
        !process.env.MS_GRAPH_TENANT_ID ||
        !process.env.MS_GRAPH_CLIENT_ID ||
        !process.env.MS_GRAPH_CLIENT_SECRET ||
        !process.env.MS_GRAPH_SENDER
      ) {
        console.error("Missing MS Graph configuration. Please check Secrets panel to ensure MS_GRAPH_TENANT_ID, MS_GRAPH_CLIENT_ID, MS_GRAPH_CLIENT_SECRET, and MS_GRAPH_SENDER are set.");
        return res.status(500).json({ error: "Email service is not configured correctly. Missing environment variables." });
      }

      const tenantId = process.env.MS_GRAPH_TENANT_ID;
      const clientId = process.env.MS_GRAPH_CLIENT_ID;
      const clientSecret = process.env.MS_GRAPH_CLIENT_SECRET;
      const senderEmail = process.env.MS_GRAPH_SENDER;

      // 1. Get Access Token
      const tokenResponse = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: clientId,
          scope: "https://graph.microsoft.com/.default",
          client_secret: clientSecret,
          grant_type: "client_credentials",
        }),
      });

      if (!tokenResponse.ok) {
        const errorData = await tokenResponse.json();
        console.error("Failed to get MS Graph access token:", errorData);
        return res.status(500).json({ error: "Email service authentication failed." });
      }

      const tokenData = await tokenResponse.json();
      const accessToken = tokenData.access_token;

      const toRecipients = to.split(',').map((email: string) => ({
        emailAddress: {
          address: email.trim(),
        },
      }));

      // 2. Send Email
      const emailBody = {
        message: {
          subject: subject,
          body: {
            contentType: "HTML",
            content: html,
          },
          toRecipients: toRecipients,
        },
        saveToSentItems: "true",
      };

      const sendResponse = await fetch(`https://graph.microsoft.com/v1.0/users/${senderEmail}/sendMail`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(emailBody),
      });

      if (!sendResponse.ok) {
        let errorData;
        try {
          errorData = await sendResponse.json();
        } catch {
          errorData = await sendResponse.text();
        }
        console.error("Failed to send email via MS Graph:", errorData);
        return res.status(500).json({ error: "Failed to send email via Microsoft Graph" });
      }

      console.log("Message sent via MS Graph successfully.");
      res.status(200).json({ message: "Email sent successfully" });
    } catch (error: any) {
      console.error("Error sending email:", error);
      res.status(500).json({ error: "Failed to send email", details: error.message });
    }
  });


  app.post("/api/gas", async (req, res) => {
    try {
      const gasUrl = "https://script.google.com/macros/s/AKfycbxwWwLIUDdFzDqIz5yWxnRWcYJDVMHl6yPr9tTkbyPzXiyubzF8D3rHTLeTjpcZxE51/exec";
      
      const response = await fetch(gasUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(req.body),
      });

      let responseText = "";
      try {
        responseText = await response.text();
      } catch (e) {
        console.error("Error reading response API GAS text:", e);
      }

      if (!response.ok) {
        console.error("GAS responded with non-200 status:", response.status, responseText);
        return res.status(500).json({ error: "Failed to send to gas", details: responseText });
      }
      res.status(200).json({ success: true });
    } catch (err: any) {
      console.error("Error connecting to GAS:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
