import { useState, useEffect } from "react";
import axios from "axios";
import { 
  ShoppingCart, 
  User, 
  LogOut, 
  Package, 
  Plus, 
  Minus, 
  X, 
  CheckCircle2, 
  AlertCircle 
} from "lucide-react";

const API = import.meta.env.VITE_API_URL || "http://localhost:5000";

function App() {
  // State: Auth
  const [token, setToken] = useState(localStorage.getItem("token"));
  const [showAuth, setShowAuth] = useState(false);
  const [authMode, setAuthMode] = useState("login"); // login | register
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  // State: Data
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState([]);
  const [orders, setOrders] = useState([]);
  
  // State: UI
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("products"); // products | orders
  const [toast, setToast] = useState({ show: false, message: "", type: "success" });
  
  // App-wide loading state to prevent UI lag while syncing with backend
  const [isLoadingProducts, setIsLoadingProducts] = useState(true);
  const [isLoadingOrders, setIsLoadingOrders] = useState(false);
  const [isProcessingOrder, setIsProcessingOrder] = useState(false);

  const api = axios.create({
    baseURL: API,
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });

  useEffect(() => {
    fetchProducts();
    if (token) fetchOrders();
  }, [token]);

  // =============== UTILS ===============
  const showToast = (message, type = "success") => {
    setToast({ show: true, message, type });
    setTimeout(() => setToast({ show: false, message: "", type: "success" }), 3000);
  };

  // =============== API CALLS ===============
  async function fetchProducts() {
    setIsLoadingProducts(true);
    try {
      const res = await axios.get(`${API}/api/products`);
      setProducts(res.data.data || []);
    } catch (e) {
      showToast("Failed loading products. Is the backend running?", "error");
      setProducts([]); // Fallback to empty to prevent UI crashing
    } finally {
      setIsLoadingProducts(false);
    }
  }

  async function fetchOrders() {
    if (!token) return;
    setIsLoadingOrders(true);
    try {
      const res = await api.get("/api/orders");
      setOrders(res.data || []);
    } catch (e) {
      console.error("Cannot load orders", e);
      // Don't show toast here as it might spam the user on load
    } finally {
      setIsLoadingOrders(false);
    }
  }

  async function handleAuth(name, email, password, authMode) {
    try {
      if (authMode === "register") {
        await axios.post(`${API}/api/register`, { name, email, password });
        showToast("Registered successfully! Please login.", "success");
        return "registered";
      } else {
        const res = await axios.post(`${API}/api/login`, { email, password });
        localStorage.setItem("token", res.data.token);
        setToken(res.data.token);
        setShowAuth(false);
        showToast("Login successful!", "success");
        return "logged_in";
      }
    } catch (e) {
      showToast(e.response?.data?.error || "Authentication failed", "error");
      return "error";
    }
  }

  function logout() {
    localStorage.removeItem("token");
    setToken(null);
    setCart([]);
    setOrders([]);
    setActiveTab("products");
    showToast("Logged out securely", "success");
  }

  // =============== CART & CHEKCOUT ===============
  function addToCart(product) {
    const found = cart.find(p => p.product_id === product.id);
    if (found) {
      setCart(cart.map(p => p.product_id === product.id ? { ...p, quantity: p.quantity + 1 } : p));
    } else {
      setCart([...cart, { product_id: product.id, name: product.name, price: product.price, quantity: 1 }]);
    }
    showToast(`Added ${product.name} to cart`);
  }

  function updateQuantity(id, change) {
    setCart(cart.map(p => {
      if (p.product_id === id) {
        const newQ = p.quantity + change;
        return newQ > 0 ? { ...p, quantity: newQ } : p;
      }
      return p;
    }).filter(p => p.quantity > 0));
  }

  const cartTotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  const cartCount = cart.reduce((sum, item) => sum + item.quantity, 0);

  async function createOrder() {
    if (!token) {
      setIsCartOpen(false);
      setShowAuth(true);
      showToast("Please login to checkout", "error");
      return;
    }

    setIsProcessingOrder(true);
    try {
      const idempotency_key = crypto.randomUUID();
      const res = await api.post("/api/orders", {
        idempotency_key,
        items: cart.map(p => ({ product_id: p.product_id, quantity: p.quantity }))
      });
      
      setCart([]);
      setIsCartOpen(false);
      // Synchronous refetch of orders to ensure UI is instantly updated
      await fetchOrders();
      showToast("Order Placed! Proceeding to Payment...", "success");
      await initiatePayment(res.data.orderId);
    } catch (e) {
      showToast(e.response?.data?.error || "Order failed (check backend logic/stock)", "error");
    } finally {
      setIsProcessingOrder(false);
    }
  }

  async function initiatePayment(orderId) {
    try {
      const res = await api.post("/api/payment/initiate", { orderId });
      confirmPayment(orderId, res.data.payment_id, res.data.signature);
    } catch (e) {
      showToast("Payment initiation failed", "error");
    }
  }

  async function confirmPayment(orderId, payment_id, signature) {
    try {
      await api.post("/api/payment/confirm", { orderId, payment_id, signature });
      showToast("Payment Successful! Everything is synced.", "success");
      await fetchOrders(); // Sync UI with the backend status change instantly
    } catch (e) {
      showToast("Payment confirmation failed", "error");
    }
  }


  // =============== COMPONENTS ===============

  const Toast = () => {
    if (!toast.show) return null;
    const isError = toast.type === "error";
    return (
      <div style={{
        position: "fixed", bottom: "2rem", right: "2rem",
        background: isError ? "#FEF2F2" : "#ECFDF5",
        border: `1px solid ${isError ? "#FECACA" : "#A7F3D0"}`,
        color: isError ? "#DC2626" : "#059669",
        padding: "1rem 1.5rem", borderRadius: "8px",
        boxShadow: "0 10px 15px -3px rgba(0,0,0,0.1)",
        display: "flex", alignItems: "center", gap: "0.75rem", zIndex: 1000,
        animation: "slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1)"
      }}>
        {isError ? <AlertCircle size={20} /> : <CheckCircle2 size={20} />}
        <span style={{ fontWeight: 600 }}>{toast.message}</span>
      </div>
    );
  };

  const CartDrawer = () => {
    if (!isCartOpen) return null;
    return (
      <>
        <div className="cart-drawer-overlay" onClick={() => setIsCartOpen(false)} />
        <div className="cart-drawer">
          <div className="cart-header">
            <h3>Your Cart ({cartCount})</h3>
            <button className="btn-icon-only" onClick={() => setIsCartOpen(false)}><X size={20} /></button>
          </div>
          
          <div className="cart-body">
            {cart.length === 0 ? (
              <div style={{ textAlign: "center", color: "var(--text-muted)", marginTop: "2rem" }}>
                <Package size={48} style={{ opacity: 0.2, margin: "0 auto 1rem" }} />
                <p>Your cart is empty.</p>
              </div>
            ) : (
              cart.map(item => (
                <div key={item.product_id} className="cart-item">
                  <div className="cart-item-info">
                    <div className="cart-item-title">{item.name}</div>
                    <div className="cart-item-price">₹{item.price}</div>
                  </div>
                  
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <button className="btn-icon-only" onClick={() => updateQuantity(item.product_id, -1)} style={{ padding: "4px" }}><Minus size={16}/></button>
                    <span style={{ fontWeight: 600, width: "20px", textAlign: "center" }}>{item.quantity}</span>
                    <button className="btn-icon-only" onClick={() => updateQuantity(item.product_id, 1)} style={{ padding: "4px" }}><Plus size={16}/></button>
                  </div>
                </div>
              ))
            )}
          </div>

          {cart.length > 0 && (
            <div className="cart-footer">
              <div className="cart-total">
                <span>Total</span>
                <span>₹{cartTotal}</span>
              </div>
              <button 
                className="btn btn-primary" 
                style={{ width: "100%", opacity: isProcessingOrder ? 0.7 : 1 }} 
                onClick={createOrder}
                disabled={isProcessingOrder}
              >
                {isProcessingOrder ? "Processing..." : "Proceed to Checkout"}
              </button>
            </div>
          )}
        </div>
      </>
    );
  };


  // =============== RENDER ===============
  return (
    <div className="app-container">
      <Toast />
      {showAuth && (
        <StandaloneAuthModal 
          onClose={() => setShowAuth(false)} 
          onSubmit={handleAuth} 
        />
      )}
      <CartDrawer />

      <header className="navbar">
        <div className="nav-brand">
          <Package style={{ color: "var(--primary)" }} />
          ApniDukan
        </div>
        
        <div className="nav-actions">
          {token ? (
            <>
              <button className={`btn ${activeTab === 'products' ? 'btn-primary' : 'btn-outline'}`} onClick={() => setActiveTab("products")}>
                Shop
              </button>
              <button className={`btn ${activeTab === 'orders' ? 'btn-primary' : 'btn-outline'}`} onClick={() => { setActiveTab("orders"); fetchOrders(); }}>
                Orders
              </button>
              <button className="btn btn-danger" onClick={logout}>
                <LogOut size={18} /> Logout
              </button>
            </>
          ) : (
             <button className="btn btn-primary" onClick={() => setShowAuth(true)}>
               <User size={18} /> Login
             </button>
          )}
          
          <div style={{ position: "relative" }}>
            <button className="btn btn-outline" style={{ padding: "10px", borderColor: "var(--border)", color: "var(--text-main)" }} onClick={() => setIsCartOpen(true)}>
              <ShoppingCart size={20} />
            </button>
            {cartCount > 0 && <span className="badge-cart">{cartCount}</span>}
          </div>
        </div>
      </header>

      <main className="main-content">
        
        {activeTab === "products" && (
          <>
            <section className="hero">
              <h1>Premium Quality Delivered</h1>
              <p>Discover our curated collection of extraordinary products designed to elevate your everyday lifestyle.</p>
            </section>
            
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "end" }}>
              <h2>Featured Products</h2>
            </div>
            
            {isLoadingProducts ? (
              <div style={{ textAlign: "center", padding: "4rem", color: "var(--text-muted)" }}>
                <div style={{ 
                  width: "40px", height: "40px", 
                  border: "4px solid var(--border)", 
                  borderTopColor: "var(--primary)", 
                  borderRadius: "50%", 
                  animation: "spin 1s linear infinite",
                  margin: "0 auto 1rem" 
                }} />
                <p>Syncing products from robust backend...</p>
                <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
              </div>
            ) : products.length === 0 ? (
               <div style={{ textAlign: "center", padding: "4rem", color: "var(--text-muted)" }}>
                 <p>No products found or backend is offline. Check your database connection.</p>
               </div>
            ) : (
              <div className="product-grid">
                {products.map(p => (
                  <div key={p.id} className="product-card">
                    <div className="product-image-placeholder">
                      <Package size={48} style={{ opacity: 0.5 }} />
                    </div>
                    <div className="product-info">
                      <h3 style={{ fontSize: "1.2rem", marginBottom: "0.25rem" }}>{p.name}</h3>
                      <p className="text-muted" style={{ fontSize: "0.9rem", flex: 1 }}>Premium item carefully selected for ApniDukan.</p>
                      <div className="product-price">₹{p.price}</div>
                      
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "1rem" }}>
                        {p.stock > 0 ? (
                          <span className="badge">In Stock ({p.stock})</span>
                        ) : (
                           <span className="badge" style={{ background: "#FEE2E2", color: "var(--danger)" }}>Out of Stock</span>
                        )}
                        
                        <button 
                          className="btn btn-primary" 
                          disabled={p.stock <= 0}
                          onClick={() => addToCart(p)}
                        >
                          <ShoppingCart size={16} /> Add
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {activeTab === "orders" && token && (
          <div>
            <h2>Your Order History</h2>
            <div className="orders-list">
              {isLoadingOrders ? (
                <div style={{ textAlign: "center", padding: "2rem", color: "var(--text-muted)" }}>
                  <p>Syncing orders...</p>
                </div>
              ) : orders.length === 0 ? (
                <p className="text-muted">You haven't placed any orders yet.</p>
              ) : (
                orders.map(o => (
                  <div key={o.id} className="order-card">
                    <div>
                      <h3 style={{ marginBottom: "0.25rem" }}>Order #{o.id}</h3>
                      <p className="text-muted" style={{ fontSize: "0.9rem" }}>Total Amount: ₹{o.total}</p>
                    </div>
                    <div>
                      <span className={`order-status ${o.status}`}>{o.status}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

      </main>
    </div>
  );
}

// Extracted AuthModal to stop entire App re-rendering on keystrokes
function StandaloneAuthModal({ onClose, onSubmit }) {
  const [authMode, setAuthMode] = useState("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsSubmitting(true);
    const result = await onSubmit(name, email, password, authMode);
    setIsSubmitting(false);
    
    if (result === "registered") {
      setAuthMode("login");
      setPassword(""); // clear password for login step
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
          <h2>{authMode === "login" ? "Welcome Back" : "Create Account"}</h2>
          <button className="btn-icon-only" onClick={onClose}><X size={20} /></button>
        </div>
        
        <form onSubmit={handleSubmit}>
          {authMode === "register" && (
            <div className="form-group">
              <label>Full Name</label>
              <input type="text" required value={name} onChange={e => setName(e.target.value)} placeholder="Jane Doe" />
            </div>
          )}
          
          <div className="form-group">
            <label>Email Address</label>
            <input type="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="jane@example.com" />
          </div>
          
          <div className="form-group">
            <label>Password</label>
            <input type="password" required value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" />
          </div>

          <button type="submit" className="btn btn-primary" style={{ width: "100%", marginTop: "1rem", opacity: isSubmitting ? 0.7 : 1 }} disabled={isSubmitting}>
            {isSubmitting ? "Processing..." : (authMode === "login" ? "Sign In" : "Sign Up")}
          </button>
        </form>

        <p style={{ textAlign: "center", marginTop: "1.5rem", color: "var(--text-muted)", fontSize: "0.9rem" }}>
          {authMode === "login" ? "Don't have an account? " : "Already have an account? "}
          <span 
            style={{ color: "var(--primary)", fontWeight: 600, cursor: "pointer" }} 
            onClick={() => setAuthMode(authMode === "login" ? "register" : "login")}
          >
            {authMode === "login" ? "Sign up here" : "Log in here"}
          </span>
        </p>
      </div>
    </div>
  );
}

export default App;