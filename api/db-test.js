const { neon } = require("@neondatabase/serverless");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  try {
    if (!process.env.DATABASE_URL) {
      return res.status(500).json({
        success: false,
        message: "DATABASE_URL is missing in Vercel"
      });
    }

    const sql = neon(process.env.DATABASE_URL);
    const result = await sql`SELECT NOW() AS database_time`;

    return res.status(200).json({
      success: true,
      message: "Database connection successful",
      databaseTime: result[0].database_time
    });
  } catch (error) {
    console.error("Database test failed:", error.message);

    return res.status(500).json({
      success: false,
      message: "Database connection failed"
    });
  }
};