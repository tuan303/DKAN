export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { to, subject, html } = req.body;

  if (!to || !subject || !html) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    if (
      !process.env.MS_GRAPH_TENANT_ID ||
      !process.env.MS_GRAPH_CLIENT_ID ||
      !process.env.MS_GRAPH_CLIENT_SECRET ||
      !process.env.MS_GRAPH_SENDER
    ) {
      console.error("Missing MS Graph configuration. Please check Vercel Environment Variables to ensure MS_GRAPH_TENANT_ID, MS_GRAPH_CLIENT_ID, MS_GRAPH_CLIENT_SECRET, and MS_GRAPH_SENDER are set.");
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

    // Parse multiple comma-separated emails
    const toList = to.split(',').map((email: string) => email.trim()).filter((email: string) => email.length > 0);
    const toRecipients = toList.map((email: string) => ({
      emailAddress: {
        address: email,
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
    return res.status(200).json({ message: "Email sent successfully" });
  } catch (error: any) {
    console.error("Error sending email:", error);
    return res.status(500).json({ error: "Failed to send email", details: error.message });
  }
}
