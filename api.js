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

	if (!orderId || !cacheKey || !prompt) {
		return res.status(400).json({ error: 'Missing fields' })
	}

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

		// 🔥 Проверяем, вернул ли Groq ошибку (401, 429 и т.д.)
		if (!response.ok) {
			const errorData = await response.text()
			console.error('❌ Ошибка Groq:', response.status, errorData)
			throw new Error(`Groq API вернул ${response.status}`)
		}

		const data = await response.json()

		// 🔥 Проверяем, есть ли вообще ответ
		if (!data.choices || !data.choices[0] || !data.choices[0].message) {
			console.error('❌ Странный ответ от Groq:', JSON.stringify(data))
			throw new Error('Groq вернул пустой ответ')
		}

		let content = data.choices[0].message.content
		if (!content) {
			throw new Error('В ответе Groq нет текста (content)')
		}

		// Очищаем от markdown
		content = content
			.replace(/^```json\s*/i, '')
			.replace(/```\s*$/i, '')
			.trim()

		let tourData
		try {
			tourData = JSON.parse(content)
		} catch (parseError) {
			console.error('❌ Ошибка парсинга JSON:', content.slice(0, 200))
			throw new Error('Нейросеть вернула невалидный JSON')
		}

		console.log(`✅ Заказ ${job.orderId} успешно сгенерирован.`)

		// Сохраняем в Supabase
		const saveRes = await fetch(`${supabaseUrl}/rest/v1/tour_cache`, {
			method: 'POST',
			headers: {
				apikey: supabaseKey,
				Authorization: `Bearer ${supabaseKey}`,
				'Content-Type': 'application/json',
				Prefer: 'return=minimal',
			},
			body: JSON.stringify({ cache_key: job.cacheKey, tour_data: tourData }),
		})

		if (!saveRes.ok) {
			console.error('❌ Ошибка сохранения в Supabase:', await saveRes.text())
		}

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
	} catch (e) {
		console.error('❌ Ошибка в очереди:', e.message)
		// Если упало, помечаем заказ как "error", чтобы фронт не висел вечно
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
	// Запускаем следующий в очереди через 2 секунды
	setTimeout(processQueue, 2000)
}

const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`✅ Proxy running on port ${PORT}`))
