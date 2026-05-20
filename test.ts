import { initializeApp } from "firebase/app";
import { getFirestore, collection, getDocs } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyAYj94j5m8wNjO15H38ayI27wyXSk2lEnQ",
  authDomain: "dkan-4b061.firebaseapp.com",
  projectId: "dkan-4b061",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function main() {
  const snap = await getDocs(collection(db, "registrations"));
  snap.docs.forEach(d => console.log(d.id, d.data()));
  process.exit(0);
}
main();
