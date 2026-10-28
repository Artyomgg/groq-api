import cors from 'cors'
import 'dotenv/config'
import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(__dirname, '.env') })

const app = express()
app.use(cors())
app.use(express.json())

const GROQ_KEY = process.env.GROQ_API_KEY
const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_KEY

// Очередь на сервере
let queue = []
let isProcessing = false

app.get('/', (req, res) => res.json({ status: 'ok', queue: queue.length }))

// 🔥 ВОТ ТОТ САМЫЙ МАРШРУТ, КОТОРЫЙ ВЫДАВАЛ 404
app.post('/api/queue', async (req, res) => {
	const { orderId, cacheKey, prompt } = req.body

	if (!orderId || !cacheKey || !prompt) {
		return res.status(400).json({ error: 'Missing fields' })
	}

	// Добавляем в очередь
	queue.push({ orderId, cacheKey, prompt })

	// Запускаем обработку, если еще не запущена
	processQueue()

	res.json({ status: 'queued', position: queue.length })
})

// Фоновая обработка очереди
async function processQueue() {
	if (isProcessing || queue.length === 0) return
	isProcessing = true

	const job = queue.shift()

	try {
		console.log(`Генерация для заказа ${job.orderId}...`)

		// Ждем 60 секунд (обход лимита Groq)
		await new Promise(r => setTimeout(r, 60000))

		const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${GROQ_KEY}`,
			},
			body: JSON.stringify({
				model: 'openai/gpt-oss-120b',
				messages: [{ role: 'user', content: job.prompt }],
				temperature: 0.3,
				max_tokens: 4000,
				response_format: { type: 'json_object' },
			}),
		})

		const data = await response.json()
		let content = data.choices?.[0]?.message?.content
		content = content
			.replace(/^```json\s*/i, '')
			.replace(/```\s*$/i, '')
			.trim()
		const tourData = JSON.parse(content)

		// Сохраняем в Supabase (используем Service Key, он обходит RLS)
		await fetch(`${supabaseUrl}/rest/v1/tour_cache`, {
			method: 'POST',
			headers: {
				apikey: supabaseKey,
				Authorization: `Bearer ${supabaseKey}`,
				'Content-Type': 'application/json',
				Prefer: 'return=minimal',
			},
			body: JSON.stringify({ cache_key: job.cacheKey, tour_data: tourData }),
		})

		// Обновляем статус заказа
		await fetch(`${supabaseUrl}/rest/v1/tour_orders?id=eq.${job.orderId}`, {
			method: 'PATCH',
			headers: {
				apikey: supabaseKey,
				Authorization: `Bearer ${supabaseKey}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ status: 'done' }),
		})

		console.log(`✅ Заказ ${job.orderId} выполнен!`)
	} catch (e) {
		console.error('Ошибка генерации:', e)
		// Если упало, помечаем заказ как error, чтобы фронт не висел вечно
		try {
			await fetch(`${supabaseUrl}/rest/v1/tour_orders?id=eq.${job.orderId}`, {
				method: 'PATCH',
				headers: {
					apikey: supabaseKey,
					Authorization: `Bearer ${supabaseKey}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ status: 'error' }),
			})
		} catch (err) {}
	}

	isProcessing = false
	processQueue() // Берем следующий из очереди
}

const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`✅ Proxy running on port ${PORT}`))
