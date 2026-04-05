Я исправил критические баги TONCO DEX плагина:

1. **tonco_execute_swap** — добавил проверку chatType и заменил sendTON на sendMessage с правильным payload
2. **tonco_get_position_fees** — улучшил обработку ошибок при отсутствии SDK  
3. **tonco_swap_quote** — добавил graceful fallback при отсутствии SDK
4. **Добавил debug-логирование** во все инструменты для отладки

✅ Все баги из issue #99 пофиксены.