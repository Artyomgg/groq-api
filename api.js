import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(__dirname, '.env') })

console.log('🔑 GROQ_API_KEY:', process.env.GROQ_API_KEY ? 'ЗАГРУЖЕН ✅' : 'НЕ НАЙДЕН ❌')

const app = express()

app.use(cors())
app.use(express.json())

app.get('/', (req, res) => {
	res.json({ status: 'ok', service: 'groq-proxy' })
})

app.post('/api/groq', async (req, res) => {
	const GROQ_KEY = process.env.GROQ_API_KEY

	if (!GROQ_KEY) {
		console.error('❌ GROQ_API_KEY не задан')
		return res.status(500).json({ error: 'Server misconfigured' })
	}

	try {
		const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${GROQ_KEY}`,
			},
			body: JSON.stringify(req.body),
		})

		const data = await response.json()
		res.status(response.status).json(data)
	} catch (error) {
		console.error('Proxy error:', error)
		res.status(500).json({ error: 'Proxy request failed', details: error.message })
	}
})

const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
	console.log(`✅ Proxy running on port ${PORT}`)
})

export default app
