export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const gasUrl = "https://script.google.com/macros/s/AKfycbyGFd2gDb0MKhn-JZDmmRneWZw_HNdf5GNm3ifQwtr5r3dPb3aP9DyLLGM9JadX4rtk/exec";
    const formData = new URLSearchParams();
    for (const key in req.body) {
      if (req.body.hasOwnProperty(key)) {
        formData.append(key, req.body[key]);
      }
    }
    const response = await fetch(gasUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formData.toString(),
    });
    if (!response.ok) {
      return res.status(500).json({ error: "Failed to send to gas" });
    }
    res.status(200).json({ success: true });
  } catch (err: any) {
    console.error("Error from gas function:", err);
    res.status(500).json({ error: err.message });
  }
}
