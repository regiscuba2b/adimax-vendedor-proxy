const fetch = require('node-fetch');
const crypto = require('crypto');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const shop = process.env.SHOPIFY_SHOP;
  const accessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  const apiSecret = process.env.SHOPIFY_API_SECRET;

  if (!shop || !accessToken) {
    return res.status(500).json({ error: 'Variáveis de ambiente do Shopify não configuradas.' });
  }

  let customerId = null;
  const queryParams = req.query;
  const isAppProxyCall = queryParams.signature && apiSecret;

  if (isAppProxyCall) {
    try {
      const signature = queryParams.signature;
      const paramsToCheck = { ...queryParams };
      delete paramsToCheck.signature;

      const message = Object.keys(paramsToCheck)
        .sort()
        .map(key => `${key}=${Array.isArray(paramsToCheck[key]) ? paramsToCheck[key].join(',') : paramsToCheck[key]}`)
        .join('');

      const calculatedSignature = crypto
        .createHmac('sha256', apiSecret)
        .update(message)
        .digest('hex');

      if (calculatedSignature === signature) {
        customerId = queryParams.logged_in_customer_id;
      }
    } catch (err) {
      console.error('Erro ao validar assinatura do App Proxy:', err);
    }
  }

  if (!customerId) {
    customerId = queryParams.customerId;
  }

  if (!customerId) {
    return res.status(400).json({ error: 'Customer ID não encontrado ou acesso não autorizado.' });
  }

  try {
    const customerQuery = `
      query getCustomerMetafield($id: ID!) {
        customer(id: $id) {
          metafield(namespace: "custom", key: "vendedor") {
            value
          }
        }
      }
    `;

    const customerRes = await fetch(`https://${shop}/admin/api/2024-04/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({
        query: customerQuery,
        variables: { id: `gid://shopify/Customer/${customerId}` }
      })
    });

    const customerData = await customerRes.json();
    const vendedorTag = customerData?.data?.customer?.metafield?.value;

    if (!vendedorTag) {
      return res.status(200).json({ orders: [], message: 'Cliente não possui metafield de vendedor.' });
    }

    const ordersQuery = `
      query getOrdersByTag($query: String!) {
        orders(first: 50, query: $query, sortKey: CREATED_AT, reverse: true) {
          edges {
            node {
              id
              name
              email
              createdAt
              displayFinancialStatus
              displayFulfillmentStatus
              totalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              shippingAddress {
                name
                address1
                city
                provinceCode
                zip
                country
              }
              customer {
                firstName
                lastName
                email
              }
              lineItems(first: 50) {
                edges {
                  node {
                    title
                    quantity
                    originalTotalPrice {
                      amount
                    }
                    variant {
                      title
                      price
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const ordersRes = await fetch(`https://${shop}/admin/api/2024-04/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({
        query: ordersQuery,
        variables: { query: `tag:${vendedorTag}` }
      })
    });

    const ordersData = await ordersRes.json();
    const edges = ordersData?.data?.orders?.edges || [];

    const formattedOrders = edges.map(({ node }) => {
      const totalItens = node.lineItems.edges.reduce((acc, { node: item }) => acc + item.quantity, 0);
      
      return {
        id: node.id,
        numero: node.name,
        email: node.email || node.customer?.email || 'N/A',
        nomeCliente: node.shippingAddress?.name || `${node.customer?.firstName || ''} ${node.customer?.lastName || ''}`.trim() || 'Cliente',
        quantidadeProdutos: totalItens,
        data: new Date(node.createdAt).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
        total: `R$ ${parseFloat(node.totalPriceSet.shopMoney.amount).toFixed(2).replace('.', ',')}`,
        statusPagamento: node.displayFinancialStatus,
        statusEnvio: node.displayFulfillmentStatus,
        endereco: node.shippingAddress,
        itens: node.lineItems.edges.map(({ node: item }) => ({
          titulo: item.title,
          variante: item.variant?.title,
          quantidade: item.quantity,
          preco: `R$ ${parseFloat(item.originalTotalPrice.amount).toFixed(2).replace('.', ',')}`
        }))
      };
    });

    return res.status(200).json({ vendedor: vendedorTag, orders: formattedOrders });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erro interno ao buscar pedidos.' });
  }
}
