import cors from 'cors'
import express from 'express'

const app = express()
app.use(cors())
app.use(express.json())

const GROQ_KEY = process.env.GROQ_API_KEY
const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_KEY

let queue = []
let isProcessing = false

app.get('/', (req, res) => res.json({ status: 'ok', queue: queue.length }))

app.post('/api/queue', async (req, res) => {
	const { orderId, cacheKey, prompt } = req.body
	if (!orderId || !cacheKey || !prompt) return res.status(400).json({ error: 'Missing fields' })

	queue.push({ orderId, cacheKey, prompt })
	processQueue()
	res.json({ status: 'queued', position: queue.length })
})

async function processQueue() {
	if (isProcessing || queue.length === 0) return
	isProcessing = true

	const job = queue.shift()

	try {
		console.log(`⏳ Генерация для заказа ${job.orderId}...`)
		await new Promise(r => setTimeout(r, 60000)) // Ждем минуту (лимит Groq)

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

		if (!response.ok) {
			const errorData = await response.text()
			throw new Error(`Groq API вернул ${response.status}: ${errorData}`)
		}

		const data = await response.json()
		if (!data.choices || !data.choices[0] || !data.choices[0].message) {
			throw new Error('Groq вернул пустой ответ (нет message)')
		}

		let content = data.choices[0].message.content
		if (!content) throw new Error('В ответе Groq нет текста (content)')

		content = content
			.replace(/^```json\s*/i, '')
			.replace(/```\s*$/i, '')
			.trim()
		const tourData = JSON.parse(content)

		// 🔥 Проверка: есть ли вообще остановки в ответе?
		if (!tourData.stops || tourData.stops.length === 0) {
			throw new Error('Нейросеть вернула JSON, но в нём нет остановок (stops)')
		}

		// 🔥 1. Сохраняем в КЭШ (чтобы при повторном заказе выдать мгновенно)
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

		// 🔥 2. Сохраняем в БАЗУ МАРШРУТОВ (чтобы он появился в Лаборатории и Админке)
		// Для этого нам нужен массив ID мест. Мы достаем его из ключа кэша.
		const parts = job.cacheKey.split('_')
		const selectedIdsStr = parts[2] // Ключ имеет вид "тема_кол-во_id1,id2"
		const routeIds = selectedIdsStr ? selectedIdsStr.split(',') : []

		await fetch(`${supabaseUrl}/rest/v1/tour_proposals`, {
			method: 'POST',
			headers: {
				apikey: supabaseKey,
				Authorization: `Bearer ${supabaseKey}`,
				'Content-Type': 'application/json',
				Prefer: 'return=minimal',
			},
			body: JSON.stringify({
				title: tourData.title || 'Сгенерированный маршрут',
				description: tourData.intro || 'Маршрут, сгенерированный нейросетью.',
				route_ids: routeIds,
				status: 'approved', // Сразу одобряем, чтобы он попал в поиск
				author_id: null, // Автор - нейросеть
			}),
		})

		// Обновляем статус заказа на "done"
		await fetch(`${supabaseUrl}/rest/v1/tour_orders?id=eq.${job.orderId}`, {
			method: 'PATCH',
			headers: {
				apikey: supabaseKey,
				Authorization: `Bearer ${supabaseKey}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ status: 'done' }),
		})

		console.log(`✅ Заказ ${job.orderId} выполнен и сохранен!`)
	} catch (e) {
		console.error('❌ Ошибка в очереди:', e.message)
		// Помечаем заказ как "error", чтобы фронт не висел
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
	setTimeout(processQueue, 2000)
}

const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`✅ Proxy running on port ${PORT}`))
