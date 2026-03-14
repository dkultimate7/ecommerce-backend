import { useState, useEffect } from "react";
import axios from "axios";

const API = import.meta.env.VITE_API_URL || "http://localhost:5000";

function App() {

const [token, setToken] = useState(localStorage.getItem("token"));

const [name,setName] = useState("");
const [email,setEmail] = useState("");
const [password,setPassword] = useState("");

const [products,setProducts] = useState([]);
const [cart,setCart] = useState([]);
const [orders,setOrders] = useState([]);

const api = axios.create({
baseURL: API,
headers: token ? { Authorization:`Bearer ${token}`} : {}
});

useEffect(()=>{
fetchProducts();
},[]);

async function fetchProducts(){

try{

const res = await axios.get(`${API}/api/products`);

setProducts(res.data.data);

}catch(e){

alert("Failed loading products");

}

}

async function register(){

try{

await axios.post(`${API}/api/register`,{
name,email,password
});

alert("User registered");

}catch(e){

alert(e.response?.data?.error || "Register failed");

}

}

async function login(){

try{

const res = await axios.post(`${API}/api/login`,{
email,password
});

localStorage.setItem("token",res.data.token);

setToken(res.data.token);

alert("Login successful");

}catch(e){

alert(e.response?.data?.error || "Login failed");

}

}

function addToCart(product){

const found = cart.find(p=>p.product_id===product.id);

if(found){

found.quantity++;

setCart([...cart]);

}else{

setCart([
...cart,
{
product_id:product.id,
name:product.name,
price:product.price,
quantity:1
}
]);

}

}

function removeFromCart(id){

setCart(cart.filter(p=>p.product_id!==id));

}

async function createOrder(){

try{

const idempotency_key = crypto.randomUUID();

const res = await api.post("/api/orders",{
idempotency_key,
items: cart.map(p=>({
product_id:p.product_id,
quantity:p.quantity
}))
});

alert("Order created: "+res.data.orderId);

initiatePayment(res.data.orderId);

}catch(e){

alert(e.response?.data?.error || "Order failed");

}

}

async function initiatePayment(orderId){

try{

const res = await api.post("/api/payment/initiate",{orderId});

confirmPayment(orderId,res.data.payment_id,res.data.signature);

}catch(e){

alert("Payment initiation failed");

}

}

async function confirmPayment(orderId,payment_id,signature){

try{

await api.post("/api/payment/confirm",{
orderId,
payment_id,
signature
});

alert("Payment successful");

}catch(e){

alert("Payment failed");

}

}

async function fetchOrders(){

try{

const res = await api.get("/api/orders");

setOrders(res.data);

}catch(e){

alert("Cannot load orders");

}

}

return(

<div style={{padding:"40px",fontFamily:"Arial"}}>

<h1>Ecommerce Store</h1>

<hr/>

<h2>Register</h2>

<input placeholder="name" onChange={(e)=>setName(e.target.value)} />
<br/><br/>

<input placeholder="email" onChange={(e)=>setEmail(e.target.value)} />
<br/><br/>

<input placeholder="password" type="password" onChange={(e)=>setPassword(e.target.value)} />
<br/><br/>

<button onClick={register}>Register</button>

<hr/>

<h2>Login</h2>

<input placeholder="email" onChange={(e)=>setEmail(e.target.value)} />
<br/><br/>

<input placeholder="password" type="password" onChange={(e)=>setPassword(e.target.value)} />
<br/><br/>

<button onClick={login}>Login</button>

<hr/>

<h2>Products</h2>

{products.map(p=>(
<div key={p.id} style={{border:"1px solid gray",padding:"10px",margin:"10px"}}>

<h3>{p.name}</h3>

<p>Price: ₹{p.price}</p>

<p>Stock: {p.stock}</p>

<button onClick={()=>addToCart(p)}>Add to Cart</button>

</div>
))}

<hr/>

<h2>Cart</h2>

{cart.map(c=>(
<div key={c.product_id}>

{c.name} x {c.quantity}

<button onClick={()=>removeFromCart(c.product_id)}>Remove</button>

</div>
))}

<br/>

<button onClick={createOrder}>Checkout</button>

<hr/>

<h2>Orders</h2>

<button onClick={fetchOrders}>Load Orders</button>

{orders.map(o=>(
<div key={o.id} style={{border:"1px solid black",margin:"10px",padding:"10px"}}>

<p>Order ID: {o.id}</p>

<p>Total: ₹{o.total}</p>

<p>Status: {o.status}</p>

</div>
))}

</div>

);

}

export default App;