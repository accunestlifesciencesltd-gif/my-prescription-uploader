const { shopifyApi, LATEST_API_VERSION } = require('@shopify/shopify-api');
require('@shopify/shopify-api/adapters/node');
const formidable = require('formidable-serverless');
const fs = require('fs');
const https = require('https');
const http = require('http');
const path = require('path');
const { URL } = require('url');

const SHOP_NAME = 'aq6tap-1i.myshopify.com';

// Initialize the Shopify API context with all required fields
const shopify = shopifyApi({
  hostName: SHOP_NAME,
  apiVersion: '2024-10',
  isCustomStoreApp: true,
  adminApiAccessToken: process.env.SHOPIFY_ADMIN_API_TOKEN,
  apiSecretKey: 'this-secret-can-be-any-string', 
});

// Mutation to create staged upload
const STAGED_UPLOADS_CREATE_MUTATION = `
  mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters {
          name
          value
        }
      }
      userErrors { field, message }
    }
  }
`;

// Mutation to create file from staged upload
const CREATE_FILE_MUTATION = `
  mutation fileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files { 
        id 
        fileStatus 
        alt
        createdAt
        ... on GenericFile {
          url
        }
        ... on MediaImage {
          image {
            url
          }
        }
        ... on Video {
          originalSource {
            url
          }
        }
      }
      userErrors { field, message }
    }
  }
`;

const UPDATE_ORDER_MUTATION = `
  mutation orderUpdate($input: OrderInput!) {
    orderUpdate(input: $input) {
      order { id, tags }
      userErrors { field, message }
    }
  }
`;

// Helper function to create multipart form data
function createMultipartData(fields, file, filename, contentType) {
  const boundary = `----formdata-${Date.now()}`;
  let body = '';

  // Add form fields
  for (const field of fields) {
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="${field.name}"\r\n\r\n`;
    body += `${field.value}\r\n`;
  }

  // Add file
  body += `--${boundary}\r\n`;
  body += `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`;
  body += `Content-Type: ${contentType}\r\n\r\n`;
  
  const bodyBuffer = Buffer.from(body);
  const fileBuffer = fs.readFileSync(file);
  const endBuffer = Buffer.from(`\r\n--${boundary}--\r\n`);
  
  return {
    buffer: Buffer.concat([bodyBuffer, fileBuffer, endBuffer]),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

// Helper function to make HTTP request
function makeRequest(url, options, data) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const client = isHttps ? https : http;

    const req = client.request({
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: options.method,
      headers: options.headers
    }, (res) => {
      let responseData = '';
      res.on('data', (chunk) => responseData += chunk);
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          text: () => Promise.resolve(responseData)
        });
      });
    });

    req.on('error', reject);
    
    if (data) {
      req.write(data);
    }
    req.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', `https://accunest.co.in`);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const form = new formidable.IncomingForm();
  
  form.parse(req, async (err, fields, files) => {
    if (err) {
      console.error('Form parsing error:', err);
      return res.status(500).json({ error: 'Error processing upload.' });
    }

    try {
      const session = shopify.session.customAppSession(SHOP_NAME);
      const client = new shopify.clients.Graphql({ session });
      
      // Get service type from form data
      const serviceType = fields.service_type;
      console.log('Service type:', serviceType);
      
      // Handle different service types
      if (serviceType === 'free_consultation') {
        // Handle free consultation request without file upload
        return await handleFreeConsultation(client, fields, res);
      } else if (serviceType === 'upload_prescription') {
        // Handle prescription upload
        return await handlePrescriptionUpload(client, fields, files, res);
      } else {
        throw new Error('Invalid service type specified');
      }
      
    } catch (error) {
      console.error('Error in processing:', error);
      res.status(500).json({ 
        error: 'An internal server error occurred. Please check the Vercel logs.',
        details: error.message 
      });
    }
  });
};

// Handle free consultation requests
async function handleFreeConsultation(client, fields, res) {
  try {
    // Find the order
    const orderDataResponse = await client.request(`
      { 
        orders(first: 1, query: "name:#${fields.order_number}") { 
          edges { 
            node { 
              id
              name
              tags
            } 
          } 
        } 
      }
    `);
    
    console.log('Order search response:', JSON.stringify(orderDataResponse, null, 2));
    
    const orderGid = orderDataResponse.data.orders.edges[0]?.node?.id;
    if (!orderGid) {
      console.error(`Order not found for number: #${fields.order_number}`);
      throw new Error(`Order with number #${fields.order_number} not found.`);
    }
    
    console.log('Found order ID:', orderGid);
    
    // Create note for consultation request
    const note = `Free consultation requested.
Customer Email: ${fields.customer_email || 'Not provided'}
Phone Number: ${fields.phone_number || 'Not provided'}
Additional Notes: ${fields.additional_notes || 'None'}`;
    
    console.log('Updating order with consultation request:', note);
    
    const orderUpdateResponse = await client.request(UPDATE_ORDER_MUTATION, {
      variables: { 
        input: { 
          id: orderGid, 
          tags: ['Consultation-Requested'], 
          note: note 
        } 
      }
    });

    console.log('Order update response:', JSON.stringify(orderUpdateResponse, null, 2));

    // Check for order update errors
    if (orderUpdateResponse.data.orderUpdate.userErrors && orderUpdateResponse.data.orderUpdate.userErrors.length > 0) {
      console.error('Order update errors:', orderUpdateResponse.data.orderUpdate.userErrors);
      throw new Error('Failed to update order: ' + orderUpdateResponse.data.orderUpdate.userErrors.map(e => e.message).join(', '));
    }
    
    res.status(200).json({ 
      success: true, 
      message: 'Consultation request submitted successfully! Our team will contact you shortly.'
    });
    
  } catch (error) {
    throw error;
  }
}

// Handle prescription upload requests
async function handlePrescriptionUpload(client, fields, files, res) {
  try {
    const prescriptionFile = files.prescription_file;
    if (!prescriptionFile) {
      throw new Error('No prescription file was received by the server.');
    }

    // Step 1: Create staged upload
    const fileSize = fs.statSync(prescriptionFile.path).size;
    const fileName = prescriptionFile.name || 'prescription.pdf';
    
    // Determine content type enum based on MIME type
    let contentType = 'FILE'; // Default to FILE
    if (prescriptionFile.type) {
      if (prescriptionFile.type.startsWith('image/')) {
        contentType = 'IMAGE';
      } else if (prescriptionFile.type.startsWith('video/')) {
        contentType = 'VIDEO';
      }
    }

    const stagedUploadResponse = await client.request(STAGED_UPLOADS_CREATE_MUTATION, {
      variables: {
        input: [{
          filename: fileName,
          mimeType: prescriptionFile.type || 'application/pdf',
          httpMethod: 'POST',
          resource: contentType
        }]
      }
    });

    if (stagedUploadResponse.data.stagedUploadsCreate.userErrors?.length > 0) {
      console.error('Staged upload errors:', stagedUploadResponse.data.stagedUploadsCreate.userErrors);
      throw new Error('Failed to create staged upload: ' + stagedUploadResponse.data.stagedUploadsCreate.userErrors.map(e => e.message).join(', '));
    }

    const stagedTarget = stagedUploadResponse.data.stagedUploadsCreate.stagedTargets[0];
    if (!stagedTarget) {
      throw new Error('No staged upload target received');
    }

    // Step 2: Upload file to staged URL
    const formFields = stagedTarget.parameters.map(param => ({
      name: param.name,
      value: param.value
    }));
    
    const multipartData = createMultipartData(
      formFields,
      prescriptionFile.path,
      fileName,
      prescriptionFile.type || 'application/pdf'
    );

    const uploadResponse = await makeRequest(stagedTarget.url, {
      method: 'POST',
      headers: {
        'Content-Type': multipartData.contentType,
        'Content-Length': multipartData.buffer.length
      }
    }, multipartData.buffer);

    if (!uploadResponse.ok) {
      console.error('File upload failed:', await uploadResponse.text());
      throw new Error('Failed to upload file to staged URL');
    }

    // Step 3: Create file record in Shopify
    const fileUploadResponse = await client.request(CREATE_FILE_MUTATION, {
      variables: {
        files: [{
          alt: `Prescription for order #${fields.order_number}`,
          contentType: contentType,
          originalSource: stagedTarget.resourceUrl,
        }],
      },
    });

    // Check for GraphQL errors
    if (fileUploadResponse.data.fileCreate.userErrors && fileUploadResponse.data.fileCreate.userErrors.length > 0) {
      console.error('Shopify file upload errors:', fileUploadResponse.data.fileCreate.userErrors);
      throw new Error('File upload to Shopify failed: ' + fileUploadResponse.data.fileCreate.userErrors.map(e => e.message).join(', '));
    }

    const uploadedFile = fileUploadResponse.data.fileCreate.files[0];
    if (!uploadedFile) {
      console.error('No file returned from Shopify');
      throw new Error('File upload to Shopify failed - no file returned.');
    }

    // Accept both UPLOADED and READY statuses
    const validStatuses = ['UPLOADED', 'READY'];
    if (!validStatuses.includes(uploadedFile.fileStatus)) {
      console.error('Shopify file upload failed. File status:', uploadedFile?.fileStatus);
      throw new Error(`File upload to Shopify failed. Status: ${uploadedFile.fileStatus}`);
    }

    console.log('File uploaded successfully with status:', uploadedFile.fileStatus);
    console.log('Uploaded file object:', JSON.stringify(uploadedFile, null, 2));

    // Get the URL based on the file type - with fallback options
    let fileUrl = null;
    
    if (uploadedFile.url) {
      // GenericFile type
      fileUrl = uploadedFile.url;
      console.log('Using GenericFile URL:', fileUrl);
    } else if (uploadedFile.image && uploadedFile.image.url) {
      // MediaImage type
      fileUrl = uploadedFile.image.url;
      console.log('Using MediaImage URL:', fileUrl);
    } else if (uploadedFile.originalSource && uploadedFile.originalSource.url) {
      // Video type
      fileUrl = uploadedFile.originalSource.url;
      console.log('Using Video URL:', fileUrl);
    } else {
      // Fallback: use the staged resource URL if no specific URL is available
      fileUrl = stagedTarget.resourceUrl;
      console.log('Using fallback resourceUrl:', fileUrl);
    }

    if (!fileUrl) {
      console.error('No file URL available from any source');
      // Continue anyway - we can still update the order without the direct file URL
      fileUrl = `File uploaded to Shopify with ID: ${uploadedFile.id}`;
    }
    
    const orderDataResponse = await client.request(`
      { 
        orders(first: 1, query: "name:#${fields.order_number}") { 
          edges { 
            node { 
              id
              name
              tags
            } 
          } 
        } 
      }
    `);
    
    console.log('Order search response:', JSON.stringify(orderDataResponse, null, 2));
    
    const orderGid = orderDataResponse.data.orders.edges[0]?.node?.id;
    if (!orderGid) {
      console.error(`Order not found for number: #${fields.order_number}`);
      console.error('Available orders:', orderDataResponse.data.orders.edges);
      throw new Error(`Order with number #${fields.order_number} not found.`);
    }
    
    console.log('Found order ID:', orderGid);
    
    const note = `Prescription uploaded.
File Link: ${fileUrl}
Customer Email: ${fields.customer_email || 'Not provided'}
Phone Number: ${fields.phone_number || 'Not provided'}
Additional Notes: ${fields.additional_notes || 'None'}`;
    
    console.log('Updating order with note:', note);
    
    const orderUpdateResponse = await client.request(UPDATE_ORDER_MUTATION, {
      variables: { 
        input: { 
          id: orderGid, 
          tags: ['Prescription-Uploaded'], 
          note: note 
        } 
      }
    });

    console.log('Order update response:', JSON.stringify(orderUpdateResponse, null, 2));

    // Check for order update errors
    if (orderUpdateResponse.data.orderUpdate.userErrors && orderUpdateResponse.data.orderUpdate.userErrors.length > 0) {
      console.error('Order update errors:', orderUpdateResponse.data.orderUpdate.userErrors);
      throw new Error('Failed to update order: ' + orderUpdateResponse.data.orderUpdate.userErrors.map(e => e.message).join(', '));
    }
    
    res.status(200).json({ 
      success: true, 
      message: 'Prescription uploaded successfully!',
      fileUrl: fileUrl
    });
    
  } catch (error) {
    throw error;
  }
}
