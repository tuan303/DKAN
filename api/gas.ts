export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const gasUrl = "https://script.google.com/macros/s/AKfycbxwWwLIUDdFzDqIz5yWxnRWcYJDVMHl6yPr9tTkbyPzXiyubzF8D3rHTLeTjpcZxE51/exec";
    
    const response = await fetch(gasUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(req.body),
      redirect: 'follow'
    });

    let responseText = "";
    try {
      responseText = await response.text();
    } catch(e) {}
    
    res.status(200).json({ status: "success", text: responseText });
  } catch (error: any) {
    console.error("Error calling GAS:", error);
    res.status(500).json({ error: "Failed to call GAS", details: error.message });
  }
}
