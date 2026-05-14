import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import nodemailer from "nodemailer";
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
      // For development/preview, if no SMTP is provided, we can use ethereal or just log it
      // but let's try to send if we have credentials, else we mock it
      if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
        console.log("-----------------------------------------");
        console.log("Mock Email Sent (No SMTP configuration inside .env):");
        console.log("To:", to);
        console.log("Subject:", subject);
        console.log("HTML:", html);
        console.log("-----------------------------------------");
        return res.status(200).json({ message: "Mock email sent successfully." });
      }

      // Configure a generic SMTP transporter (you can adjust host/port based on your provider)
      // Usually users will set SMTP_HOST and SMTP_PORT as well
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || "smtp.gmail.com",
        port: parseInt(process.env.SMTP_PORT || "587"),
        secure: process.env.SMTP_SECURE === "true" || false,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });

      const info = await transporter.sendMail({
        from: `BỘ PHẬN DINH DƯỠNG <dinhduong@hoangmaistarschool.edu.vn>`,
        to,
        subject,
        html,
      });

      console.log("Message sent: %s", info.messageId);
      res.status(200).json({ message: "Email sent successfully", info: info.messageId });
    } catch (error: any) {
      console.error("Error sending email:", error);
      res.status(500).json({ error: "Failed to send email", details: error.message });
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
