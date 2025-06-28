// Substitua a função setupDatabase por esta
async function setupDatabase() {
  let clientDB;
  let retryCount = 0;
  const maxRetries = 3;

  while (retryCount < maxRetries) {
    try {
      clientDB = await pool.connect();
      
      const checkTable = await clientDB.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' AND table_name = 'clientes'
        );
      `);

      if (!checkTable.rows[0].exists) {
        await clientDB.query(`
          CREATE TABLE clientes (
            telefone VARCHAR(20) PRIMARY KEY,
            nome VARCHAR(255) NOT NULL,
            endereco TEXT NOT NULL,
            referencia TEXT,
            criado_em TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
          );
        `);
        logger.info('Tabela "clientes" criada com sucesso.');
      } else {
        logger.info('Tabela "clientes" já existe.');
      }
      return;
    } catch (err) {
      retryCount++;
      // LOG MELHORADO: Mostra a mensagem de erro específica do banco de dados
      logger.error(`Erro ao configurar banco (tentativa ${retryCount}/${maxRetries}): ${err.message}`);
      console.error('Detalhes completos do erro de conexão:', err); // Loga o objeto de erro inteiro
      
      if (retryCount < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 2000 * retryCount));
      }
    } finally {
      if (clientDB) clientDB.release();
    }
  }
  throw new Error('Falha ao configurar o banco de dados após várias tentativas');
}
