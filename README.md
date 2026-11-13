# prc3_banco

## Arrancar el servidor

1. Instala las dependencias:

   ```bash
   npm install
   ```

2. Copia `.env.example` a `.env` y configura tu URI de MongoDB Atlas:

   ```env
   MONGODB_URI=mongodb+srv://<usuario>:<password>@<cluster-url>/
   MONGODB_DATABASE=prc3_banco
   PORT=3000
   ```

3. Inicia el servidor en modo desarrollo:

   ```bash
   npm run dev
   ```
