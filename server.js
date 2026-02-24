require("dotenv").config();
console.log("ENV CHECK:", process.env.DB_USER, process.env.DB_HOST);

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { z } = require("zod");
const app = express();   // ✅ MUST COME BEFORE app.use()

const PAYMENT_SECRET = process.env.PAYMENT_SECRET;


// ================= VALIDATION SCHEMAS =================

// Register Schema
const registerSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6),
});

// Login Schema
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// Create Order Schema
const createOrderSchema = z.object({
  idempotency_key: z.string().min(1),
  items: z.array(
    z.object({
      product_id: z.number().int().positive(),
      quantity: z.number().int().positive(),
    })
  ).min(1),
});

// Payment Confirm Schema
const paymentConfirmSchema = z.object({
  orderId: z.number().int().positive(),
  payment_id: z.string().min(1),
  signature: z.string().min(1),
});

/* =====================================================
   ENVIRONMENT VALIDATION (FAIL FAST)
===================================================== */
if (
  !process.env.DB_HOST ||
  !process.env.DB_USER ||
  !process.env.DB_PASSWORD ||
  !process.env.DB_NAME ||
  !process.env.JWT_SECRET ||
  !process.env.PAYMENT_SECRET
) {
  console.error("Missing required environment variables.");
  process.exit(1);
}

/* =====================================================
   SECURITY MIDDLEWARE
===================================================== */


/* =====================================================
   RATE LIMITERS
===================================================== */
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
});

/* =====================================================
   RATE LIMITERS (SECURITY PERIMETER)
===================================================== */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: "Too many login attempts. Try again later." },
});

const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "Too many registrations. Try again later." },
});

const orderLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: "Too many order requests. Slow down." },
});

const paymentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: "Too many payment attempts. Slow down." },
});


/* =====================================================
   SECURITY & MIDDLEWARE HARDENING
===================================================== */
app.use((req, res, next) => {
  req.requestId = crypto.randomBytes(6).toString("hex");
  res.setHeader("X-Request-ID", req.requestId);
  next();
});


app.use(helmet());

const allowedOrigins =
  process.env.NODE_ENV === "production"
    ? ["https://your-frontend-domain.com"]
    : ["*"];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json({ limit: "1mb" }));

// Strict body parser for sensitive endpoints
const smallBodyParser = express.json({ limit: "10kb" });

app.use(globalLimiter);
app.use("/api/login", loginLimiter);

/* =====================================================
   BASIC REQUEST LOGGING (OBSERVABILITY BASE)
===================================================== */
app.use((req, res, next) => {
  const start = Date.now();

  res.on("finish", () => {
    const duration = Date.now() - start;

    const label = duration > 300 ? "⚠️ SLOW REQUEST" : "REQ";

    console.log(
      `[${req.requestId}] ${label} ${req.method} ${req.originalUrl} | ${res.statusCode} | ${duration} ms`
    );
  });

  next();
});



/* =====================================================
   DATABASE CONNECTION POOL
===================================================== */
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 20,
  queueLimit: 0,
});

db.getConnection((err, connection) => {
  if (err) {
    console.error("Database connection failed:", err);
    process.exit(1);
  }
  console.log("MySQL Pool Connected");
  connection.release();
});

// ================= SIMPLE PRODUCT CACHE =================
const productCache = new Map();
const PRODUCT_CACHE_TTL = 60 * 1000; // 60 seconds


function timedQuery(sql, params) {
  return new Promise((resolve, reject) => {
    const start = process.hrtime.bigint();

    db.query(sql, params, (err, results) => {
      const end = process.hrtime.bigint();
      const durationMs = Number(end - start) / 1e6;

      const label = durationMs > 20 ? "⚠️ SLOW QUERY" : "DB";
console.log(`[${label}] ${durationMs.toFixed(2)} ms | ${sql.split("\n")[0]}`);


      if (err) return reject(err);
      resolve(results);
    });
  });
}

function queryAsync(connection, sql, params) {
  return new Promise((resolve, reject) => {
    connection.query(sql, params, (err, results) => {
      if (err) return reject(err);
      resolve(results);
    });
  });
}


async function executeTransactionWithRetry(transactionFn, maxRetries = 3) {
  let attempt = 0;

  while (attempt < maxRetries) {
    const connection = await new Promise((resolve, reject) => {
      db.getConnection((err, conn) => {
        if (err) return reject(err);
        resolve(conn);
      });
    });

    try {
      await new Promise((resolve, reject) => {
        connection.beginTransaction(err => {
          if (err) return reject(err);
          resolve();
        });
      });

      const result = await transactionFn(connection);

      await new Promise((resolve, reject) => {
        connection.commit(err => {
          if (err) return reject(err);
          resolve();
        });
      });

      connection.release();
      return result;

    } catch (err) {
      await new Promise(resolve => {
        connection.rollback(() => {
          connection.release();
          resolve();
        });
      });

      if (err.code === "ER_LOCK_DEADLOCK") {
        attempt++;
        console.warn(`Deadlock detected. Retrying transaction (${attempt}/${maxRetries})`);
        continue;
      }

      throw err;
    }
  }

  throw new Error("Transaction failed after maximum retries");
}


/* =====================================================
   AUTH MIDDLEWARE
===================================================== */

function authenticateToken(req, res, next) {
  try {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];

    if (!token) {
      return res.status(401).json({ error: "Access token required" });
    }

    jwt.verify(
      token,
      process.env.JWT_SECRET,
      { algorithms: ["HS256"] }, // 🔒 Explicit algorithm whitelist
      (err, decoded) => {
        if (err) {
          return res.status(403).json({ error: "Invalid token" });
        }

        // 🔐 Check token_version in DB
        db.query(
          "SELECT token_version FROM users WHERE id = ?",
          [decoded.id],
          (dbErr, results) => {
            if (dbErr) return next(dbErr);

            if (results.length === 0) {
              return res.status(403).json({ error: "User not found" });
            }

            const currentVersion = results[0].token_version;

            if (currentVersion !== decoded.token_version) {
              return res.status(403).json({ error: "Token revoked" });
            }

            // Attach verified user to request
            req.user = decoded;
            req.tokenIssuedAt = decoded.iat;

            next();
          }
        );
      }
    );
  } catch (error) {
    next(error);
  }
}

/* =====================================================
   ADMIN CHECK
===================================================== */

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}
/* =====================================================
   HEALTH CHECK ENDPOINT
===================================================== */
app.get("/health", async (req, res) => {
  try {
    await timedQuery("SELECT 1", []);
    res.json({ status: "healthy" });
  } catch (err) {
    res.status(500).json({ status: "unhealthy" });
  }
});

/* =====================================================
   ROOT
===================================================== */
app.get("/", (req, res) => {
  res.send("Ecommerce API Running");
});

/* =====================================================
   REGISTER
===================================================== */
app.post("/api/register", registerLimiter, smallBodyParser, async (req, res, next) => {
  try {
    const parseResult = registerSchema.safeParse(req.body);

if (!parseResult.success) {
  const isProduction = process.env.NODE_ENV === "production";

  return res.status(400).json(
    isProduction
      ? { error: "Invalid request data" }
      : {
          error: "Invalid input",
          details: parseResult.error.issues,
        }
  );
}

const { name, email, password } = parseResult.data;
    const hashedPassword = await bcrypt.hash(password, 10);

    db.query(
      "INSERT INTO users (name, email, password) VALUES (?, ?, ?)",
      [name, email, hashedPassword],
      (err) => {
        if (err)
          return res.status(400).json({ error: "Email already exists" });

        res.json({ message: "User registered successfully" });
      }
    );
  } catch (error) {
    next(error);
  }
});

/* =====================================================
   LOGIN
===================================================== */
app.post("/api/login", loginLimiter, smallBodyParser, (req, res, next) => {
  const parseResult = loginSchema.safeParse(req.body);

if (!parseResult.success) {
  const isProduction = process.env.NODE_ENV === "production";

  return res.status(400).json(
    isProduction
      ? { error: "Invalid request data" }
      : {
          error: "Invalid input",
          details: parseResult.error.issues,
        }
  );
}

const { email, password } = parseResult.data;

  db.query(
    "SELECT * FROM users WHERE email = ?",
    [email],
    async (err, results) => {
      if (err) return next(err);

      if (results.length === 0)
        return res.status(400).json({ error: "User not found" });

      const user = results[0];

      const validPassword = await bcrypt.compare(password, user.password);
      if (!validPassword)
        return res.status(400).json({ error: "Invalid password" });

      const token = jwt.sign(
  {
    id: user.id,
    email: user.email,
    role: user.role,
    token_version: user.token_version,
  },
  process.env.JWT_SECRET,
  {
    algorithm: "HS256",
    expiresIn:
  process.env.NODE_ENV === "production" ? "15m" : "1h",
  }
);

      res.json({ message: "Login successful", token });
    }
  );
});

/* =====================================================
   ADD PRODUCT
===================================================== */
app.post("/api/products", authenticateToken, requireAdmin, (req, res, next) => {
  try {
    const {
      name,
      description,
      image,
      video,
      price,
      stock,
      restock_date,
      delivery_days,
    } = req.body;

    if (!name || price == null || stock == null)
      return res.status(400).json({ error: "Required fields missing" });

    db.query(
      `INSERT INTO products
       (name, description, image, video, price, stock, restock_date, delivery_days)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, description, image, video, price, stock, restock_date, delivery_days],
      (err, result) => {
        if (err) return next(err);

        // 🔥 Invalidate product cache
    productCache.clear();
        res.json({
          message: "Product added successfully",
          id: result.insertId,
        });
      }
    );
  } catch (error) {
    next(error);
  }
});

/* =====================================================
   GET PRODUCTS
===================================================== */
app.get("/api/products", (req, res, next) => {
  
  try {
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || "";
    const lastId = req.query.lastId ? parseInt(req.query.lastId) : null;


    // 🔹 Build cache key
    const cacheKey = `products:${limit}:${search}:${lastId || "none"}`;

    const cached = productCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < PRODUCT_CACHE_TTL) {
      console.log("⚡ Serving products from cache");
      return res.json(cached.data);
    }
    let sql = `
SELECT id, name, price, stock, delivery_days
FROM products
WHERE name LIKE ?
`;
    const params = [`%${search}%`];

    if (lastId) {
      sql += " AND id < ?";
      params.push(lastId);
    }

    sql += " ORDER BY id DESC LIMIT ?";
    params.push(limit);

    
    db.query(sql, params, (err, results) => {
      if (err) return next(err);

      const responseData = { count: results.length, data: results };

      // 🔹 Store in cache
      productCache.set(cacheKey, {
        data: responseData,
        timestamp: Date.now(),
      });

      res.json(responseData);
    });
  } catch (error) {
    next(error);
  }
});


/* =====================================================
   CREATE ORDER (ASYNC + DEADLOCK RETRY SAFE)
===================================================== */
app.post("/api/orders", authenticateToken, orderLimiter, async (req, res, next) => {

  const userId = req.user.id;
  const parseResult = createOrderSchema.safeParse(req.body);

if (!parseResult.success) {
  const isProduction = process.env.NODE_ENV === "production";

  return res.status(400).json(
    isProduction
      ? { error: "Invalid request data" }
      : {
          error: "Invalid input",
          details: parseResult.error.issues,
        }
  );
}

const { items, idempotency_key } = parseResult.data;

  try {

    const result = await executeTransactionWithRetry(async (connection) => {

      // 1️⃣ Idempotency check
      const existing = await queryAsync(
        connection,
        "SELECT id FROM orders WHERE idempotency_key = ? AND user_id = ?",
        [idempotency_key, userId]
      );

      if (existing.length > 0) {
        return { orderId: existing[0].id, alreadyExists: true };
      }

      let totalAmount = 0;
      const validatedProducts = [];

      // 2️⃣ Lock + Validate + Deduct Stock
      for (const item of items) {

        const { product_id, quantity } = item;

        if (!product_id || !quantity || quantity <= 0) {
          throw new Error("Invalid product data");
        }

        const productRows = await queryAsync(
          connection,
          "SELECT stock, price FROM products WHERE id = ? FOR UPDATE",
          [product_id]
        );

        if (productRows.length === 0) {
          throw new Error("Product not found");
        }

        const product = productRows[0];

        if (product.stock < quantity) {
          throw new Error("Insufficient stock");
        }

        totalAmount += product.price * quantity;

        validatedProducts.push({
          product_id,
          quantity,
          price: product.price
        });

        await queryAsync(
          connection,
          "UPDATE products SET stock = stock - ? WHERE id = ?",
          [quantity, product_id]
        );
      }

      // 3️⃣ Create order
      const orderResult = await queryAsync(
        connection,
        `INSERT INTO orders 
         (user_id, total, status, idempotency_key)
         VALUES (?, ?, 'pending', ?)`,
        [userId, totalAmount, idempotency_key]
      );

      const orderId = orderResult.insertId;

      // 4️⃣ Insert items + inventory ledger
      for (const item of validatedProducts) {

        await queryAsync(
          connection,
          `INSERT INTO order_items
           (order_id, product_id, quantity, price)
           VALUES (?, ?, ?, ?)`,
          [orderId, item.product_id, item.quantity, item.price]
        );

        await queryAsync(
          connection,
          `INSERT INTO inventory_movements
           (product_id, order_id, type, quantity)
           VALUES (?, ?, 'deduction', ?)`,
          [item.product_id, orderId, item.quantity]
        );
      }

      return { orderId, alreadyExists: false };

    });

    if (result.alreadyExists) {
      return res.json({
        message: "Order already exists",
        orderId: result.orderId
      });
    }

    // Non-critical ledger (outside transaction)
    db.query(
      `INSERT INTO order_events
       (order_id, event_type, previous_status, new_status, metadata, actor_user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        result.orderId,
        "order_created",
        null,
        "pending",
        JSON.stringify({ idempotency_key }),
        userId
      ]
    );

    res.json({
      message: "Order created successfully",
      orderId: result.orderId
    });

  } catch (err) {

    if (
      err.message === "Product not found" ||
      err.message === "Insufficient stock" ||
      err.message === "Invalid product data"
    ) {
      return res.status(400).json({ error: err.message });
    }

    next(err);
  }

});


 
/* =====================================================
   INITIATE PAYMENT
===================================================== */
app.post("/api/payment/initiate", authenticateToken, paymentLimiter, (req, res, next) => {

  const { orderId } = req.body;

  if (!orderId)
    return res.status(400).json({ error: "Order ID required" });

  db.query(
  "SELECT * FROM orders WHERE id = ? AND user_id = ?",
  [orderId, req.user.id],
  (err, results) => {
    if (err) return next(err);

    if (results.length === 0)
      return res.status(404).json({ error: "Order not found" });

    const order = results[0];

    if (order.status !== "pending")
      return res.status(400).json({ error: "Order not eligible for payment" });

    const payment_id = "pay_" + crypto.randomBytes(8).toString("hex");

    const signature = crypto
      .createHmac("sha256", PAYMENT_SECRET)
      .update(orderId + "|" + payment_id)
      .digest("hex");

    res.json({ message: "Payment initiated", orderId, payment_id, signature });
  }
);

});

/* =====================================================
   CONFIRM PAYMENT (SHARED SETTLEMENT ENGINE)
===================================================== */

// 🔥 Shared Settlement Logic (Used by Confirm + Future Webhook)
async function settlePayment(orderId, payment_id, actorUserId) {
  return new Promise((resolve, reject) => {

    const updateSql = `
  UPDATE orders
  SET status = 'paid',
      payment_id = ?,
      payment_verified = TRUE
  WHERE id = ?
  AND user_id = ?
  AND status = 'pending'
`;

    db.query(updateSql, [payment_id, orderId, actorUserId], (err, result) => {
      if (err) return reject(err);

      // 🔹 Idempotent behavior
      if (result.affectedRows === 0) {

        db.query(
          "SELECT status FROM orders WHERE id = ?",
          [orderId],
          (err, rows) => {
            if (err) return reject(err);

            if (rows.length === 0) {
              return reject(new Error("Order not found"));
            }

            if (rows[0].status === "paid") {
              return resolve({ alreadySettled: true });
            }

            return reject(new Error("Invalid state transition"));
          }
        );

        return;
      }

      // 🔹 Insert ledger event (non-blocking on failure)
      db.query(
        `INSERT INTO order_events
         (order_id, event_type, previous_status, new_status, metadata, actor_user_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          orderId,
          "payment_confirmed",
          "pending",
          "paid",
          JSON.stringify({ payment_id }),
          actorUserId
        ],
        (eventErr) => {
          if (eventErr) {
            console.error("Ledger insert failed:", eventErr);
          }

          resolve({ alreadySettled: false });
        }
      );
    });

  });
}


/* =====================================================
   CONFIRM PAYMENT ROUTE
===================================================== */

app.post("/api/payment/confirm", authenticateToken, paymentLimiter, smallBodyParser, async (req, res, next) => {

  try {
    const parseResult = paymentConfirmSchema.safeParse(req.body);

if (!parseResult.success) {
  const isProduction = process.env.NODE_ENV === "production";

  return res.status(400).json(
    isProduction
      ? { error: "Invalid request data" }
      : {
          error: "Invalid input",
          details: parseResult.error.issues,
        }
  );
}

const { orderId, payment_id, signature } = parseResult.data;

    // 🔹 Verify HMAC signature (Mock Gateway Validation)
    const data = orderId + "|" + payment_id;

    const expectedSignature = crypto
      .createHmac("sha256", PAYMENT_SECRET)
      .update(data)
      .digest("hex");

    if (expectedSignature !== signature) {
      return res.status(400).json({ error: "Invalid payment signature" });
    }

    // 🔹 Call shared settlement logic
    const result = await settlePayment(orderId, payment_id, req.user.id);

    if (result.alreadySettled) {
      return res.json({ message: "Payment already settled" });
    }

    return res.json({ message: "Payment verified successfully" });

  } catch (error) {
    next(error);
  }
});


/* =====================================================
   PAYMENT FAILURE
===================================================== */
app.post("/api/payment/fail", authenticateToken, paymentLimiter, (req, res) => {

  const { orderId } = req.body;

  db.query(
    `UPDATE orders
     SET status='failed'
     WHERE id=? AND status='pending'`,
    [orderId],
    (err, result) => {
      if (err)
        return res.status(500).json({ error: "Database error" });

      if (result.affectedRows === 0)
        return res.status(400).json({ error: "Invalid state transition" });

      res.json({ message: "Payment marked as failed" });
    }
  );
});

/* =====================================================
   GET USER ORDERS (TIMED)
===================================================== */
app.get("/api/orders", authenticateToken, async (req, res) => {

  const sql = `
    SELECT id, total, status, payment_verified, created_at
    FROM orders
    WHERE user_id = ?
    ORDER BY created_at DESC
  `;

  try {
    const results = await timedQuery(sql, [req.user.id]);
    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }

});


/* =====================================================
   GET SINGLE ORDER WITH ITEMS
===================================================== */
app.get("/api/orders/:id", authenticateToken, (req, res) => {
  const orderId = parseInt(req.params.id);

  db.query(
    `SELECT id,total,status,payment_verified,created_at
     FROM orders
     WHERE id=? AND user_id=?`,
    [orderId, req.user.id],
    (err, orderResults) => {
      if (err)
        return res.status(500).json({ error: "Database error" });

      if (orderResults.length === 0)
        return res.status(404).json({ error: "Order not found" });

      db.query(
        `SELECT oi.product_id,p.name,oi.quantity,oi.price
         FROM order_items oi
         JOIN products p ON oi.product_id=p.id
         WHERE oi.order_id=?`,
        [orderId],
        (err, itemResults) => {
          if (err)
            return res.status(500).json({ error: "Database error" });

          res.json({ order: orderResults[0], items: itemResults });
        }
      );
    }
  );
});



/* =====================================================
   CANCEL ORDER (ASYNC + DEADLOCK RETRY SAFE)
===================================================== */
app.post("/api/orders/:id/cancel", authenticateToken, async (req, res, next) => {

  const userId = req.user.id;
  const orderId = parseInt(req.params.id);

  if (!orderId) {
    return res.status(400).json({ error: "Invalid order id" });
  }

  try {

    const result = await executeTransactionWithRetry(async (connection) => {

      // 1️⃣ Lock order row (race protection)
      const orderRows = await queryAsync(
        connection,
        `SELECT status
         FROM orders
         WHERE id = ? AND user_id = ?
         FOR UPDATE`,
        [orderId, userId]
      );

      if (orderRows.length === 0) {
        throw new Error("Order not found");
      }

      const currentStatus = orderRows[0].status;

      if (currentStatus !== "pending") {
        throw new Error("Only pending orders can be cancelled");
      }

      // 2️⃣ Atomic state transition
      const updateResult = await queryAsync(
        connection,
        `UPDATE orders
         SET status = 'cancelled'
         WHERE id = ?
         AND status = 'pending'`,
        [orderId]
      );

      if (updateResult.affectedRows === 0) {
        throw new Error("Order already processed");
      }

      // 3️⃣ Fetch order items
      const items = await queryAsync(
        connection,
        `SELECT product_id, quantity
         FROM order_items
         WHERE order_id = ?`,
        [orderId]
      );

      // 4️⃣ Restore stock (exact same logic as before)
      for (const item of items) {

        await queryAsync(
          connection,
          `UPDATE products
           SET stock = stock + ?
           WHERE id = ?`,
          [item.quantity, item.product_id]
        );

        // Optional inventory ledger symmetry
        await queryAsync(
          connection,
          `INSERT INTO inventory_movements
           (product_id, order_id, type, quantity)
           VALUES (?, ?, 'deduction', ?)`,
          [item.product_id, orderId, -item.quantity]
        );
      }

      return { orderId };

    });

    // 🔹 Non-critical event log (outside transaction, same as original)
    db.query(
      `INSERT INTO order_events
       (order_id, event_type, previous_status, new_status, metadata, actor_user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        result.orderId,
        "order_cancelled",
        "pending",
        "cancelled",
        JSON.stringify({ reason: "user_requested" }),
        userId
      ]
    );

    res.json({
      message: "Order cancelled and stock restored"
    });

  } catch (err) {

    if (
      err.message === "Order not found" ||
      err.message === "Only pending orders can be cancelled" ||
      err.message === "Order already processed"
    ) {
      return res.status(400).json({ error: err.message });
    }

    next(err);
  }

});



/* =====================================================
   REQUEST RETURN (ASYNC + DEADLOCK RETRY SAFE)
===================================================== */
app.post("/api/returns/request", authenticateToken, async (req, res, next) => {

  const userId = req.user.id;
  const { orderId, items } = req.body;

  if (!orderId || !items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Invalid return request" });
  }

  try {

    await executeTransactionWithRetry(async (connection) => {

      // 1️⃣ Lock order
      const orderRows = await queryAsync(
        connection,
        "SELECT id, status FROM orders WHERE id = ? AND user_id = ? FOR UPDATE",
        [orderId, userId]
      );

      if (orderRows.length === 0) {
        throw new Error("Order not found");
      }

      if (orderRows[0].status !== "delivered") {
        throw new Error("Return allowed only after delivery");
      }

      // 2️⃣ Process each item
      for (const item of items) {

        const { order_item_id, quantity, reason } = item;

        if (!order_item_id || !quantity || quantity <= 0) {
          throw new Error("Invalid item data");
        }

        const itemRows = await queryAsync(
          connection,
          "SELECT quantity, returned_quantity FROM order_items WHERE id = ? AND order_id = ? FOR UPDATE",
          [order_item_id, orderId]
        );

        if (itemRows.length === 0) {
          throw new Error("Invalid order item");
        }

        const orderItem = itemRows[0];

        if (orderItem.returned_quantity + quantity > orderItem.quantity) {
          throw new Error("Return quantity exceeds purchased quantity");
        }

        await queryAsync(
          connection,
          `INSERT INTO returns (order_item_id, quantity, reason)
           VALUES (?, ?, ?)`,
          [order_item_id, quantity, reason || null]
        );
      }

      return true;

    });

    res.json({ message: "Return request submitted" });

  } catch (err) {

    if (
      err.message === "Order not found" ||
      err.message === "Return allowed only after delivery" ||
      err.message === "Invalid item data" ||
      err.message === "Invalid order item" ||
      err.message === "Return quantity exceeds purchased quantity"
    ) {
      return res.status(400).json({ error: err.message });
    }

    next(err);
  }

});


/* =====================================================
   APPROVE RETURN (ADMIN ONLY — RETRY SAFE)
===================================================== */
app.post(
  "/api/returns/:id/approve",
  authenticateToken,
  requireAdmin,
  async (req, res, next) => {

    const returnId = parseInt(req.params.id);

    try {

      await executeTransactionWithRetry(async (connection) => {

        // 1️⃣ Lock return row
        const [returnRows] = await connection.promise().query(
          "SELECT * FROM returns WHERE id = ? FOR UPDATE",
          [returnId]
        );

        if (returnRows.length === 0) {
          throw { status: 404, message: "Return not found" };
        }

        const returnRow = returnRows[0];

        if (returnRow.status !== "requested") {
          throw { status: 400, message: "Return already processed" };
        }

        // 2️⃣ Lock order item
        const [itemRows] = await connection.promise().query(
          "SELECT * FROM order_items WHERE id = ? FOR UPDATE",
          [returnRow.order_item_id]
        );

        if (itemRows.length === 0) {
          throw { status: 400, message: "Invalid order item" };
        }

        const orderItem = itemRows[0];

        const newReturnedQty =
          orderItem.returned_quantity + returnRow.quantity;

        if (newReturnedQty > orderItem.quantity) {
          throw { status: 400, message: "Return exceeds purchased quantity" };
        }

        // 3️⃣ Update returned quantity
        await connection.promise().query(
          "UPDATE order_items SET returned_quantity = ? WHERE id = ?",
          [newReturnedQty, orderItem.id]
        );

        // 4️⃣ Restore stock
        await connection.promise().query(
          "UPDATE products SET stock = stock + ? WHERE id = ?",
          [returnRow.quantity, orderItem.product_id]
        );

        // 5️⃣ Inventory movement log
        await connection.promise().query(
          `INSERT INTO inventory_movements
           (product_id, order_id, type, quantity)
           VALUES (?, ?, 'return_restore', ?)`,
          [
            orderItem.product_id,
            orderItem.order_id,
            returnRow.quantity
          ]
        );

        const refundAmount =
          orderItem.price * returnRow.quantity;

        // 6️⃣ Insert refund record
        await connection.promise().query(
          `INSERT INTO refunds
           (order_id, return_id, amount)
           VALUES (?, ?, ?)`,
          [orderItem.order_id, returnId, refundAmount]
        );

        // 7️⃣ Update return status
        await connection.promise().query(
          `UPDATE returns
           SET status = 'approved',
               approved_at = NOW()
           WHERE id = ?`,
          [returnId]
        );

        // 8️⃣ Update order refund total
        await connection.promise().query(
          `UPDATE orders
           SET refund_total = refund_total + ?
           WHERE id = ?`,
          [refundAmount, orderItem.order_id]
        );

        // 9️⃣ Compute summary for return status
        const [summaryRows] = await connection.promise().query(
          `SELECT
             COALESCE(SUM(quantity), 0) AS total_qty,
             COALESCE(SUM(returned_quantity), 0) AS returned_qty
           FROM order_items
           WHERE order_id = ?`,
          [orderItem.order_id]
        );

        const totalQty = Number(summaryRows[0].total_qty);
        const returnedQty = Number(summaryRows[0].returned_qty);

        let newReturnStatus = "none";

        if (returnedQty === 0) {
          newReturnStatus = "none";
        } else if (returnedQty < totalQty) {
          newReturnStatus = "partial";
        } else {
          newReturnStatus = "full";
        }

        await connection.promise().query(
          `UPDATE orders
           SET return_status = ?
           WHERE id = ?`,
          [newReturnStatus, orderItem.order_id]
        );

        // 🔥 Ledger event
        await connection.promise().query(
          `INSERT INTO order_events
           (order_id, event_type, previous_status, new_status, metadata)
           VALUES (?, ?, ?, ?, ?)`,
          [
            orderItem.order_id,
            "return_approved",
            null,
            newReturnStatus,
            JSON.stringify({ return_id: returnId })
          ]
        );

        // 🔥 Full return → mark order returned
        if (newReturnStatus === "full") {
          await connection.promise().query(
            `UPDATE orders
             SET status = 'returned'
             WHERE id = ?
             AND status = 'delivered'`,
            [orderItem.order_id]
          );
        }

        res.json({
          message: "Return approved and refund recorded",
          refundAmount,
          returnStatus: newReturnStatus
        });

      });

    } catch (err) {

      if (err.status) {
        return res.status(err.status).json({ error: err.message });
      }

      next(err);
    }

  }
);

/* =====================================================
   COMPLETE REFUND (ADMIN ONLY)
===================================================== */
app.post("/api/refunds/:id/complete", authenticateToken, requireAdmin, (req, res, next) => {

  const refundId = parseInt(req.params.id);

  if (!refundId) {
    return res.status(400).json({ error: "Invalid refund ID" });
  }

  db.getConnection((err, connection) => {
    if (err) return next(err);

    connection.beginTransaction(err => {
      if (err) {
        connection.release();
        return next(err);
      }

      // 1️⃣ Lock refund row
      connection.query(
        "SELECT * FROM refunds WHERE id = ? FOR UPDATE",
        [refundId],
        (err, refundResults) => {

          if (err || refundResults.length === 0) {
            return connection.rollback(() => {
              connection.release();
              res.status(404).json({ error: "Refund not found" });
            });
          }

          const refundRow = refundResults[0];

          if (refundRow.status !== "initiated") {
            return connection.rollback(() => {
              connection.release();
              res.status(400).json({ error: "Refund already processed" });
            });
          }

          // 2️⃣ Lock related order
          connection.query(
            "SELECT id, return_status FROM orders WHERE id = ? FOR UPDATE",
            [refundRow.order_id],
            (err, orderResults) => {

              if (err || orderResults.length === 0) {
                return connection.rollback(() => {
                  connection.release();
                  res.status(500).json({ error: "Associated order not found" });
                });
              }

              const order = orderResults[0];

              // 3️⃣ Update refund → completed
              connection.query(
                `UPDATE refunds
                 SET status = 'completed',
                     completed_at = NOW()
                 WHERE id = ?`,
                [refundId],
                (err, updateRefundResult) => {

                  if (err || updateRefundResult.affectedRows === 0) {
                    return connection.rollback(() => {
                      connection.release();
                      next(err || new Error("Refund update failed"));
                    });
                  }

                  let newOrderStatus = null;

                  if (order.return_status === "full") {
                    newOrderStatus = "refunded";
                  } else if (order.return_status === "partial") {
                    newOrderStatus = "partially_refunded";
                  }

                  if (!newOrderStatus) {
                    return connection.rollback(() => {
                      connection.release();
                      res.status(400).json({
                        error: "Order return_status invalid for refund completion"
                      });
                    });
                  }

                  // 4️⃣ Update order main status
                  connection.query(
                    `UPDATE orders
                     SET status = ?
                     WHERE id = ?`,
                    [newOrderStatus, order.id],
                    (err, updateOrderResult) => {

                      if (err || updateOrderResult.affectedRows === 0) {
                        return connection.rollback(() => {
                          connection.release();
                          next(err || new Error("Order status update failed"));
                        });
                      }

                      // 5️⃣ Insert event into ledger
                      connection.query(
                        `INSERT INTO order_events
                         (order_id, event_type, previous_status, new_status, metadata, actor_user_id)
                         VALUES (?, ?, ?, ?, ?, ?)`,
                        [
                          order.id,
                          "refund_completed",
                          order.return_status === "full" ? "returned" : "delivered",
                          newOrderStatus,
                          JSON.stringify({ refund_id: refundId }),
                          req.user.id
                        ],
                        (err) => {

                          if (err) {
                            return connection.rollback(() => {
                              connection.release();
                              next(err);
                            });
                          }

                          // 6️⃣ Commit transaction
                          connection.commit(commitErr => {
                            connection.release();

                            if (commitErr) {
                              return next(commitErr);
                            }

                            res.json({
                              message: "Refund completed successfully",
                              refundId: refundId,
                              orderStatus: newOrderStatus
                            });
                          });

                        }
                      );

                    }
                  );

                }
              );

            }
          );

        }
      );

    });

  });

});


/* =====================================================
   REJECT RETURN (ADMIN ONLY)
===================================================== */
app.post("/api/returns/:id/reject", authenticateToken, requireAdmin, (req, res, next) => {
  const returnId = parseInt(req.params.id);

  db.getConnection((err, connection) => {
    if (err) return next(err);

    connection.beginTransaction(err => {
      if (err) {
        connection.release();
        return next(err);
      }

      // 1️⃣ Lock return row
      connection.query(
        "SELECT * FROM returns WHERE id = ? FOR UPDATE",

        [returnId],
        (err, results) => {
          if (err || results.length === 0) {
            return connection.rollback(() => {
              connection.release();
              res.status(404).json({ error: "Return not found" });
            });
          }

          
const returnRow = results[0];
const currentStatus = returnRow.status;

          if (currentStatus !== "requested") {
            return connection.rollback(() => {
              connection.release();
              res.status(400).json({ error: "Return already processed" });
            });
          }

          // 2️⃣ Update status → rejected
connection.query(
  "UPDATE returns SET status = 'rejected' WHERE id = ?",
  [returnId],
  (err) => {
    if (err) {
      return connection.rollback(() => {
        connection.release();
        next(err);
      });
    }

    // 🔹 Fetch order_id from order_items using returnRow.order_item_id
    connection.query(
      "SELECT order_id FROM order_items WHERE id = ?",
      [returnRow.order_item_id],
      (err, orderResults) => {

        if (err || orderResults.length === 0) {
          return connection.rollback(() => {
            connection.release();
            next(err || new Error("Order item not found"));
          });
        }

        const orderId = orderResults[0].order_id;

        // 🔹 Commit transaction FIRST
        connection.commit((err) => {
          connection.release();
          if (err) return next(err);

          // 🔹 Insert ledger event OUTSIDE transaction
          db.query(
            `INSERT INTO order_events
             (order_id, event_type, previous_status, new_status, metadata, actor_user_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
              orderId,
              "return_rejected",
              "requested",
              "rejected",
              JSON.stringify({ return_id: returnId }),
              req.user.id
            ],
            (eventErr) => {
              if (eventErr) {
                console.error("Ledger insert failed:", eventErr);
              }

              res.json({ message: "Return rejected successfully" });
            }
          );
        });

      }
    );
  



            }
          );
        }
      );
    });
  });
});


/* =====================================================
   GLOBAL ERROR HANDLER
===================================================== */
app.use((err, req, res, next) => {
  const isProduction = process.env.NODE_ENV === "production";

  console.error(
    `[${req.requestId}] ERROR:`,
    err.message,
    "\nStack:",
    err.stack
  );

  // Handle oversized payloads
  if (err.type === "entity.too.large") {
    return res.status(413).json({
      error: "Payload too large",
      requestId: req.requestId,
    });
  }

  // Handle malformed JSON
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({
      error: "Malformed JSON",
      requestId: req.requestId,
    });
  }

  if (!isProduction) {
    return res.status(500).json({
      error: err.message,
      stack: err.stack,
      requestId: req.requestId,
    });
  }

  res.status(500).json({
    error: "Internal server error",
    requestId: req.requestId,
  });
});


/* =====================================================
   SERVER START
===================================================== */
const server = app.listen(5000, () => {
  console.log("Server running on port 5000");
});

// ================= PROCESS CRASH HANDLERS =================

process.on("unhandledRejection", (reason, promise) => {
  console.error("UNHANDLED REJECTION:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
  process.exit(1); // crash intentionally so PM2 can restart
});

// ================= GRACEFUL SHUTDOWN =================

function shutdown() {
  console.log("🛑 Graceful shutdown initiated...");

  server.close(() => {
    console.log("HTTP server closed.");

    db.end((err) => {
      if (err) {
        console.error("Error closing MySQL pool:", err);
        process.exit(1);
      }

      console.log("MySQL pool closed.");
      process.exit(0);
    });
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);