// init_db.js
const mysql = require('mysql2/promise');
require('dotenv').config();

async function initializeDatabase() {
  console.log("🚀 Starting Database Initialization...");
  
  // Connect to MySQL server first (without database selected)
  let connection;
  try {
    connection = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || ''
    });
    console.log("✅ Successfully connected to MySQL server!");
  } catch (error) {
    console.error("❌ Failed to connect to MySQL server. Please ensure MySQL is running locally and the credentials in .env are correct.");
    console.error("Error details:", error.message);
    process.exit(1);
  }

  try {
    const dbName = process.env.DB_NAME || 'ecommerce';
    
    // Create database if it doesn't exist
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\`;`);
    console.log(`✅ Database '${dbName}' verified/created.`);
    
    // Switch to the database
    await connection.query(`USE \`${dbName}\`;`);

    // Create Tables
    console.log("⏳ Creating tables...");

    await connection.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        role ENUM('customer', 'admin') DEFAULT 'customer',
        token_version INT DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS products (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        image VARCHAR(255),
        video VARCHAR(255),
        price DECIMAL(10, 2) NOT NULL,
        stock INT NOT NULL DEFAULT 0,
        restock_date DATE,
        delivery_days INT DEFAULT 3,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        total DECIMAL(10, 2) NOT NULL,
        status ENUM('pending', 'paid', 'shipped', 'delivered', 'cancelled') DEFAULT 'pending',
        idempotency_key VARCHAR(255) UNIQUE NOT NULL,
        payment_id VARCHAR(255),
        payment_verified BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_id INT NOT NULL,
        product_id INT NOT NULL,
        quantity INT NOT NULL,
        price DECIMAL(10, 2) NOT NULL,
        FOREIGN KEY (order_id) REFERENCES orders(id),
        FOREIGN KEY (product_id) REFERENCES products(id)
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS inventory_movements (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_id INT NOT NULL,
        order_id INT,
        type ENUM('addition', 'deduction', 'adjustment') NOT NULL,
        quantity INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (product_id) REFERENCES products(id)
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS order_events (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_id INT NOT NULL,
        event_type VARCHAR(100) NOT NULL,
        previous_status VARCHAR(50),
        new_status VARCHAR(50) NOT NULL,
        metadata JSON,
        actor_user_id INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (order_id) REFERENCES orders(id),
        FOREIGN KEY (actor_user_id) REFERENCES users(id)
      )
    `);

    console.log("✅ All tables created successfully!");

    // Insert Dummy Products so the storefront isn't empty
    const [rows] = await connection.query("SELECT COUNT(*) as count FROM products");
    if (rows[0].count === 0) {
      console.log("⏳ Seeding dummy products...");
      await connection.query(`
        INSERT INTO products (name, description, price, stock) VALUES
        ('Premium Headphones', 'High quality noise cancelling', 199.99, 50),
        ('Mechanical Keyboard', 'RGB Mechanical Switches', 129.50, 20),
        ('Wireless Mouse', 'Ergonomic design', 59.99, 100),
        ('4K Monitor', 'Ultra HD Display', 399.00, 15)
      `);
      console.log("✅ Dummy products inserted!");
    }

    console.log("🎉 Database initialization complete!");
    process.exit(0);

  } catch (error) {
    console.error("❌ Error during database creation:");
    console.error(error);
    process.exit(1);
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

initializeDatabase();
