import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'
import { HttpsProxyAgent } from 'https-proxy-agent'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(__dirname, '.env') })

console.log('📂 CWD:', process.cwd())
console.log('🔑 GROQ_API_KEY:', process.env.GROQ_API_KEY ? 'ЗАГРУЖЕН ✅' : 'НЕ НАЙДЕН ❌')
console.log(
	'🌐 QUOTAGUARDSTATIC_URL:',
	process.env.QUOTAGUARDSTATIC_URL ? 'ЗАГРУЖЕН ✅' : 'НЕ НАЙДЕН (идём напрямую)',
)

// Агент для проксирования через QuotaGuard (если URL задан)
const proxyAgent = process.env.QUOTAGUARDSTATIC_URL
	? new HttpsProxyAgent(process.env.QUOTAGUARDSTATIC_URL)
	: null

const app = express()

app.use(cors())
app.use(express.json())

app.get('/', (req, res) => {
	res.json({
		status: 'ok',
		service: 'groq-proxy',
		proxy: proxyAgent ? 'quotaguard' : 'direct',
	})
})

app.post('/api/groq', async (req, res) => {
	const GROQ_KEY = process.env.GROQ_API_KEY

	if (!GROQ_KEY) {
		console.error('❌ GROQ_API_KEY не задан')
		return res.status(500).json({ error: 'Server misconfigured' })
	}

	try {
		const fetchOptions = {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${GROQ_KEY}`,
			},
			body: JSON.stringify(req.body),
		}

		// Если есть QuotaGuard — добавляем агент
		if (proxyAgent) {
			fetchOptions.agent = proxyAgent
		}

		const response = await fetch('https://api.groq.com/openai/v1/chat/completions', fetchOptions)

		const data = await response.json()
		res.status(response.status).json(data)
	} catch (error) {
		console.error('Proxy error:', error)
		res.status(500).json({ error: 'Proxy request failed', details: error.message })
	}
})

const PORT = process.env.PORT || 3001
if (process.env.NODE_ENV !== 'production') {
	app.listen(PORT, () => {
		console.log(`✅ Proxy running on http://localhost:${PORT}`)
		if (proxyAgent) {
			console.log('🔒 Исходящие запросы идут через QuotaGuard')
		} else {
			console.log('⚡ Исходящие запросы идут напрямую (без прокси)')
		}
	})
}

export default app
